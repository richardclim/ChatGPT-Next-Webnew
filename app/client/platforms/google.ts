import { ApiPath, Google, ServiceProvider } from "@/app/constant";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  SpeechOptions,
} from "../api";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
  ChatMessageTool,
  ChatMessage,
} from "@/app/store";
import { stream, streamWithThink } from "@/app/utils/chat";
import { getClientConfig } from "@/app/config/client";
import { GEMINI_BASE_URL } from "@/app/constant";
import {
  tavilyToolDeclaration,
  TAVILY_TOOL_NAME,
  createTavilyHandler,
  tavilyRetrieveDeclaration,
  TAVILY_RETRIEVE_TOOL_NAME,
  createTavilyRetrieveHandler,
} from "@/app/client/tools/tavily";

import {
  getMessageTextContent,
  getMessageImages,
  getMessageFiles,
  isVisionModel,
  getTimeoutMSByModel,
} from "@/app/utils";
import { preProcessImageContent } from "@/app/utils/chat";
import { nanoid } from "nanoid";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";
import { resolveReasoningEffort } from "@/app/utils/model-utils";

export class GeminiProApi implements LLMApi {
  path(path: string, shouldStream = false): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";
    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.googleUrl;
    }

    const isApp = !!getClientConfig()?.isApp;
    if (baseUrl.length === 0) {
      baseUrl = isApp ? GEMINI_BASE_URL : ApiPath.Google;
    }
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Google)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    let chatPath = [baseUrl, path].join("/");
    if (shouldStream) {
      chatPath += chatPath.includes("?") ? "&alt=sse" : "?alt=sse";
    }

    return chatPath;
  }
  extractMessage(res: any) {
    console.log("[Response] gemini-pro response: ", res);

    const getTextFromParts = (parts: any[]) => {
      if (!Array.isArray(parts)) return "";

      return parts
        .map((part) => part?.text || "")
        .filter((text) => text.trim() !== "")
        .join("\n\n");
    };

    let content = "";
    if (Array.isArray(res)) {
      res.map((item) => {
        content += getTextFromParts(item?.candidates?.at(0)?.content?.parts);
      });
    }

    return (
      getTextFromParts(res?.candidates?.at(0)?.content?.parts) ||
      content || //getTextFromParts(res?.at(0)?.candidates?.at(0)?.content?.parts) ||
      res?.error?.message ||
      ""
    );
  }
  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions): Promise<void> {
    const apiClient = this;
    let multimodal = false;

    // try get base64image from local cache image_url
    const _messages: ChatOptions["messages"] = [];
    for (const v of options.messages as ChatMessage[]) {
      let content = (await preProcessImageContent(v.content)) as any;
      if (v.role === "assistant" && v.tools && v.tools.length > 0) {
        const toolLogs = v.tools
          .map((t) => {
            const name = t.function?.name || t.type;
            const args =
              typeof t.function?.arguments === "string"
                ? t.function?.arguments
                : JSON.stringify(t.function?.arguments || {});
            return `Executed: ${name}\nArguments: ${args}`;
          })
          .join("\n\n");
        content = `${content}\n\n<tool_memory>\nTurn ID: ${v.id}\n${toolLogs}\n</tool_memory>`;
      }
      _messages.push({ role: v.role, content });
    }

    // Extract the first system message as a dedicated system_instruction.
    // Remaining system messages (e.g. memory summary) stay in contents as
    // user-role messages, matching the previous behaviour.
    let systemInstructionText = "";
    const firstSystemIdx = _messages.findIndex((v) => v.role === "system");
    if (firstSystemIdx !== -1) {
      systemInstructionText = getMessageTextContent(_messages[firstSystemIdx]);
      _messages.splice(firstSystemIdx, 1);
    }

    const messages = _messages.map((v) => {
      let parts: any[] = [{ text: getMessageTextContent(v) }];
      if (isVisionModel(options.config.model)) {
        const images = getMessageImages(v);
        if (images.length > 0) {
          multimodal = true;
          parts = parts.concat(
            images.map((image) => {
              const imageType = image.split(";")[0].split(":")[1];
              const imageData = image.split(",")[1];
              return {
                inline_data: {
                  mime_type: imageType,
                  data: imageData,
                },
              };
            }),
          );
        }
        const files = getMessageFiles(v);
        if (files.length > 0) {
          multimodal = true;
          parts = parts.concat(
            files.map((file) => {
              const data = file.url.split(",")[1];
              return {
                inline_data: {
                  mime_type: file.mimeType,
                  data,
                },
              };
            }),
          );
        }
      }
      return {
        role: v.role.replace("assistant", "model").replace("system", "user"),
        parts: parts,
      };
    });

    // google requires that role in neighboring messages must not be the same
    for (let i = 0; i < messages.length - 1; ) {
      // Check if current and next item both have the role "model"
      if (messages[i].role === messages[i + 1].role) {
        // Concatenate the 'parts' of the current and next item
        messages[i].parts = messages[i].parts.concat(messages[i + 1].parts);
        // Remove the next item
        messages.splice(i + 1, 1);
      } else {
        // Move to the next item
        i++;
      }
    }
    // if (visionModel && messages.length > 1) {
    //   options.onError?.(new Error("Multiturn chat is not enabled for models/gemini-pro-vision"));
    // }

    const accessStore = useAccessStore.getState();
    const googleHeaders = getHeaders(false, ServiceProvider.Google);

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...options.config,
    };
    const isThinking =
      options.config.model.includes("-thinking") ||
      options.config.model.includes("pro") ||
      options.config.model.includes("gemini-3-flash-preview");

    // Resolve effort from config, falling back to highest available
    const effortLevel = resolveReasoningEffort(
      options.config.model,
      modelConfig.reasoningEffort,
    );

    const requestPayload = {
      ...(systemInstructionText && {
        system_instruction: {
          parts: [{ text: systemInstructionText }],
        },
      }),
      contents: messages,
      generationConfig: {
        // stopSequences: [
        //   "Title"
        // ],
        temperature: modelConfig.temperature,
        ...(modelConfig.max_tokens > 0 && {
          maxOutputTokens: modelConfig.max_tokens,
        }),
        topP: modelConfig.top_p,
        responseMimeType: options.config.responseMimeType,
        responseSchema: options.config.responseJsonSchema,
        // "topK": modelConfig.top_k,
        ...(isThinking && {
          thinking_config: {
            ...(effortLevel
              ? { thinking_level: effortLevel }
              : { thinking_budget: 32768 }),
            include_thoughts: true,
          },
        }),
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: accessStore.googleSafetySettings,
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: accessStore.googleSafetySettings,
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: accessStore.googleSafetySettings,
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: accessStore.googleSafetySettings,
        },
      ],
    };

    let shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);
    try {
      // https://github.com/google-gemini/cookbook/blob/main/quickstarts/rest/Streaming_REST.ipynb
      const chatPath = this.path(
        Google.ChatPath(
          modelConfig.model.includes("gemini-3-flash-preview")
            ? "gemini-3-flash-preview"
            : modelConfig.model,
        ),
        shouldStream,
      );

      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: googleHeaders,
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        getTimeoutMSByModel(options.config.model),
      );

      if (shouldStream) {
        let [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          ) as [any[], Record<string, Function>];

        if (modelConfig.enableTavily) {
          tools.push(tavilyToolDeclaration);
          funcs[TAVILY_TOOL_NAME] = createTavilyHandler(modelConfig);
        }

        const processToolMessage = (
          requestPayload: RequestPayload,
          toolCallMessage: any,
          toolCallResult: any[],
        ) => {
          // @ts-ignore
          requestPayload?.contents?.splice(
            // @ts-ignore
            requestPayload?.contents?.length,
            0,
            {
              role: "model",
              parts: toolCallMessage.tool_calls.map(
                (tool: ChatMessageTool) => {
                  const { name, arguments: argsStr, ...rest } = tool?.function || {};
                  return {
                    functionCall: {
                      name,
                      args: argsStr ? JSON.parse(argsStr as string) : {},
                      ...rest,
                    },
                  };
                }
              ),
            },
            // @ts-ignore
            ...toolCallResult.map((result) => ({
              role: "function",
              parts: [
                {
                  functionResponse: {
                    name: result.name,
                    response: {
                      name: result.name,
                      content: result.content, // TODO just text content...
                    },
                  },
                },
              ],
            })),
          );
        };

        const toolDeclarations =
          // @ts-ignore
          tools.length > 0
            ? // @ts-ignore
              [{ functionDeclarations: tools.map((tool) => tool.function) }]
            : [];

        if (isThinking) {
          return streamWithThink(
            chatPath,
            requestPayload,
            googleHeaders,
            toolDeclarations,
            funcs,
            controller,
            (text: string, runTools: ChatMessageTool[]) => {
              const chunkJson = JSON.parse(text);

              const functionCall = chunkJson?.candidates
                ?.at(0)
                ?.content.parts.at(0)?.functionCall;
              if (functionCall) {
                const { name, args, ...rest } = functionCall;
                runTools.push({
                  id: nanoid(),
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(args),
                    ...rest,
                  },
                });
              }

              const parts = chunkJson?.candidates?.at(0)?.content?.parts;
              if (!parts || parts.length === 0) {
                return { isThinking: false, content: undefined };
              }
              const isThinkingPart = !!parts[0].thought;
              const content = parts
                .map((part: { text: string }) => part.text)
                .join("");

              return { isThinking: isThinkingPart, content };
            },
            processToolMessage,
            options,
          );
        }

        return stream(
          chatPath,
          requestPayload,
          googleHeaders,
          toolDeclarations,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            // console.log("parseSSE", text, runTools);
            const chunkJson = JSON.parse(text);

            const functionCall = chunkJson?.candidates
              ?.at(0)
              ?.content.parts.at(0)?.functionCall;
            if (functionCall) {
              const { name, args, ...rest } = functionCall;
              runTools.push({
                id: nanoid(),
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(args), // utils.chat call function, using JSON.parse
                  ...rest,
                },
              });
            }
            return chunkJson?.candidates
              ?.at(0)
              ?.content.parts?.map((part: { text: string }) => part.text)
              .join("\n\n");
          },
          // processToolMessage, include tool_calls message and tool call results
          processToolMessage,
          options,
        );
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);
        const resJson = await res.json();
        if (resJson?.promptFeedback?.blockReason) {
          // being blocked
          options.onError?.(
            new Error(
              "Message is being blocked for reason: " +
                resJson.promptFeedback.blockReason,
            ),
          );
        }
        const message = apiClient.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  usage(): Promise<LLMUsage> {
    throw new Error("Method not implemented.");
  }
  async models(): Promise<LLMModel[]> {
    return [];
  }
}
