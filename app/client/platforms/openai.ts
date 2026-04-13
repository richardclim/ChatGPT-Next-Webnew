"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  OPENAI_BASE_URL,
  DEFAULT_MODELS,
  OpenaiPath,
  Azure,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
  DEFAULT_SYSTEM_TEMPLATE,
  TAVILY_SYSTEM_TEMPLATE,
} from "@/app/constant";
import {
  ChatMessageTool,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
  TimingInfo,
  ChatMessage,
} from "@/app/store";
import { collectModelsWithDefaultModel } from "@/app/utils/model";
import {
  tavilyToolDeclaration,
  TAVILY_TOOL_NAME,
  createTavilyHandler,
  tavilyRetrieveDeclaration,
  TAVILY_RETRIEVE_TOOL_NAME,
  createTavilyRetrieveHandler,
} from "@/app/client/tools/tavily";
import {
  preProcessImageContent,
  stripFileContent,
  uploadImage,
  base64Image2Blob,
  streamWithThink,
} from "@/app/utils/chat";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";
import { ModelSize, DalleQuality, DalleStyle } from "@/app/typing";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  isVisionModel,
  isDalle3 as _isDalle3,
  getTimeoutMSByModel,
} from "@/app/utils";
import { fetch } from "@/app/utils/stream";
import {
  parseGpt5Model,
  resolveReasoningEffort,
} from "@/app/utils/model-utils";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export interface BaseRequest {
  stream?: boolean;
  model: string;
  temperature?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  top_p: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}
export interface RequestPayload extends BaseRequest {
  messages: {
    role: "developer" | "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  include_reasoning?: boolean;
  reasoning_effort?: string;
  response_format?: object;
}

export interface ResponseRequestPayload extends BaseRequest {
  input:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
        | { type: "input_file"; file_data: string; filename?: string }
        | { type: "function_call_output"; call_id: string; output: string }
      >;
  reasoning: {
    effort: "none" | "low" | "medium" | "high" | "xhigh";
    summary: "auto";
  };
  text: {
    verbosity: "low" | "medium" | "high";
  };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: object;
    };
  }>;
  store?: boolean;
  previous_response_id?: string;
  max_output_tokens?: number;
  instructions?: string;
}

export interface DalleRequestPayload {
  model: string;
  prompt: string;
  response_format: "url" | "b64_json";
  n: number;
  size: ModelSize;
  quality: DalleQuality;
  style: DalleStyle;
}

/**
 * Convert MultimodalContent into the Responses API input format.
 * Returns a plain string when the message is text-only, or an array
 * of input_text / input_image / input_file items when it contains
 * images or file attachments.
 */
async function buildResponsesInput(
  content: string | MultimodalContent[],
): Promise<ResponseRequestPayload["input"]> {
  if (typeof content === "string") return content;

  const hasNonText = content.some(
    (p) => p.type === "image_url" || p.type === "file",
  );
  if (!hasNonText) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }

  const parts: Exclude<ResponseRequestPayload["input"], string> = [];

  for (const part of content) {
    if (part.type === "text" && part.text) {
      parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      parts.push({ type: "input_image", image_url: part.image_url.url });
    } else if (part.type === "file" && part.file?.url) {
      parts.push({
        type: "input_file",
        file_data: part.file.url,
        ...(part.file.name ? { filename: part.file.name } : {}),
      });
    }
  }

  return parts;
}

export class ChatGPTApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    const isAzure = path.includes("deployments");
    if (accessStore.useCustomConfig) {
      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isAzure ? ApiPath.Azure : ApiPath.OpenAI;
      baseUrl = isApp ? OPENAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !isAzure &&
      !baseUrl.startsWith(ApiPath.OpenAI)
    ) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl([baseUrl, path].join("/"));
  }

  async extractMessage(res: any) {
    if (res.error) {
      return "```\n" + JSON.stringify(res, null, 4) + "\n```";
    }
    // dalle3 model return url, using url create image message
    if (res.data) {
      let url = res.data?.at(0)?.url ?? "";
      const b64_json = res.data?.at(0)?.b64_json ?? "";
      if (!url && b64_json) {
        // uploadImage
        url = await uploadImage(base64Image2Blob(b64_json, "image/png"));
      }
      return [
        {
          type: "image_url",
          image_url: {
            url,
          },
        },
      ];
    }

    // Responses API (gpt-5): res.object === "response" and content is in output[*].content[*].text
    if (res.object === "response" && Array.isArray(res.output)) {
      const msg =
        res.output.find(
          (o: any) => o.type === "message" && o.role === "assistant",
        ) ?? res.output.find((o: any) => o.type === "message");
      if (msg?.content) {
        const text = msg.content
          .filter(
            (c: any) =>
              c?.type === "output_text" && typeof c?.text === "string",
          )
          .map((c: any) => c.text)
          .join("");
        return text ?? "";
      }
      return "";
    }

    return res.choices?.at(0)?.message?.content ?? res;
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    const requestPayload = {
      model: options.model,
      input: options.input,
      voice: options.voice,
      response_format: options.response_format,
      speed: options.speed,
    };

    console.log("[Request] openai speech payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const speechPath = this.path(OpenaiPath.SpeechPath);
      const speechPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(speechPath, speechPayload);
      clearTimeout(requestTimeoutId);
      return await res.arrayBuffer();
    } catch (e) {
      console.log("[Request] failed to make a speech request", e);
      throw e;
    }
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...options.config,
    };

    let requestPayload:
      | RequestPayload
      | DalleRequestPayload
      | ResponseRequestPayload;

    const isDalle3 = _isDalle3(options.config.model);
    const isO1OrO3 =
      options.config.model.startsWith("o1") ||
      options.config.model.startsWith("o3") ||
      options.config.model.startsWith("o4-mini");

    // Unified GPT-5 model parsing
    const gpt5Info = parseGpt5Model(
      options.config.model,
      modelConfig.reasoningEffort,
    );
    const isGpt5 =
      gpt5Info.isGpt5 &&
      !options.config.useStandardCompletion &&
      !modelConfig.enableTavily;

    if (isDalle3) {
      const prompt = getMessageTextContent(
        options.messages.slice(-1)?.pop() as any,
      );
      requestPayload = {
        model: options.config.model,
        prompt,
        // URLs are only valid for 60 minutes after the image has been generated.
        response_format: "b64_json", // using b64_json, and save image in CacheStorage
        n: 1,
        size: options.config?.size ?? "1024x1024",
        quality: options.config?.quality ?? "standard",
        style: options.config?.style ?? "vivid",
      };
    } else {
      if (isGpt5) {
        const session = useChatStore.getState().currentSession();
        const sessionId = session?.id as string;

        const lastMsg = options.messages.slice(-1)[0];

        // Build multimodal input for the Responses API when the message
        // contains images or files; fall back to plain text otherwise.
        const responsesInput = await buildResponsesInput(lastMsg.content);

        // const prevId = this.gpt5PrevIdBySession.get(sessionId);
        const prevId = [...session.messages].reverse().find((m) => m.gpt5PrevId)
          ?.gpt5PrevId;

        requestPayload = {
          stream: options.config.stream,
          model: gpt5Info.normalizedModel,
          top_p: modelConfig.top_p,
          instructions:
            DEFAULT_SYSTEM_TEMPLATE +
            (modelConfig.enableTavily ? "\n\n" + TAVILY_SYSTEM_TEMPLATE : ""),
          // only send latest user turn; rely on previous_response_id for history
          input: responsesInput,
          reasoning: {
            effort:
              gpt5Info.reasoningEffort as ResponseRequestPayload["reasoning"]["effort"],
            summary: "auto",
          },
          text: {
            verbosity: gpt5Info.verbosity!,
          },
          // max_output_tokens: modelConfig.max_tokens,
          store: true,
          ...(prevId ? { previous_response_id: prevId } : {}),
        };
      } else {
        const visionModel = isVisionModel(options.config.model);
        const messages: ChatOptions["messages"] = [];
        for (const v of options.messages as ChatMessage[]) {
          let content = visionModel
            ? stripFileContent(await preProcessImageContent(v.content))
            : getMessageTextContent(v);
          if (!(isO1OrO3 && v.role === "system")) {
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
            messages.push({ role: v.role, content });
          }
        }

        const payload: RequestPayload = {
          messages,
          stream: options.config.stream,
          model: gpt5Info.normalizedModel,
          temperature: !isO1OrO3 ? modelConfig.temperature : 1,
          presence_penalty: !isO1OrO3 ? modelConfig.presence_penalty : 0,
          frequency_penalty: !isO1OrO3 ? modelConfig.frequency_penalty : 0,
          top_p: !isO1OrO3 ? modelConfig.top_p : 1,
          ...(modelConfig.providerName == ServiceProvider.Anthropic && {
            include_reasoning: true,
          }),
          ...(gpt5Info.isGpt5 &&
            gpt5Info.reasoningEffort && {
              reasoning_effort: gpt5Info.reasoningEffort,
            }),
          ...(!gpt5Info.isGpt5 &&
            resolveReasoningEffort(
              options.config.model,
              modelConfig.reasoningEffort,
            ) && {
              reasoning_effort: resolveReasoningEffort(
                options.config.model,
                modelConfig.reasoningEffort,
              ),
            }),
          ...(options.config.response_format
            ? {
                response_format: options.config.response_format,
              }
            : {}),
        };

        if (isO1OrO3) {
          // by default the o1/o3 models will not attempt to produce output that includes markdown formatting
          // manually add "Formatting re-enabled" developer message to encourage markdown inclusion in model responses
          // (https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/reasoning?tabs=python-secure#markdown-output)
          payload.messages.unshift({
            role: "developer",
            content: "Formatting re-enabled",
          });

          // o1/o3 uses max_completion_tokens (0 = let API decide)
          if (modelConfig.max_tokens > 0) {
            payload.max_completion_tokens = modelConfig.max_tokens;
          }
        }

        // gpt-5 also uses max_completion_tokens
        if (gpt5Info.isGpt5 && modelConfig.max_tokens > 0) {
          payload.max_completion_tokens = modelConfig.max_tokens;
        }

        // add max_tokens to vision model (but not o1/o3/gpt-5 which use max_completion_tokens)
        if (visionModel && !isO1OrO3 && !gpt5Info.isGpt5) {
          if (modelConfig.max_tokens > 0) {
            payload.max_tokens = Math.max(modelConfig.max_tokens, 4000);
          }
        }
        requestPayload = payload;
      }
    }

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = !isDalle3 && !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let chatPath = "";
      if (modelConfig.providerName === ServiceProvider.Azure) {
        // find model, and get displayName as deployName
        const { models: configModels, customModels: configCustomModels } =
          useAppConfig.getState();
        const {
          defaultModel,
          customModels: accessCustomModels,
          useCustomConfig,
        } = useAccessStore.getState();
        const models = collectModelsWithDefaultModel(
          configModels,
          [configCustomModels, accessCustomModels].join(","),
          defaultModel,
        );
        const model = models.find(
          (model) =>
            model.name === modelConfig.model &&
            model?.provider?.providerName === ServiceProvider.Azure,
        );
        chatPath = this.path(
          (isDalle3 ? Azure.ImagePath : Azure.ChatPath)(
            (model?.displayName ?? model?.name) as string,
            useCustomConfig ? useAccessStore.getState().azureApiVersion : "",
          ),
        );
      } else if (isGpt5) {
        chatPath = this.path(OpenaiPath.ResponsePath);
      } else {
        chatPath = this.path(
          isDalle3 ? OpenaiPath.ImagePath : OpenaiPath.ChatPath,
        );
      }
      if (shouldStream) {
        let index = -1;
        let tools: any[] = [];
        let funcs: Record<string, Function> = {};

        if (!options.config.useStandardCompletion) {
          const plugins = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            ) as [any[], Record<string, Function>];
          tools = plugins[0];
          funcs = plugins[1];

          if (modelConfig.enableTavily) {
            tools.push(tavilyToolDeclaration as any);
            funcs[TAVILY_TOOL_NAME] = createTavilyHandler(modelConfig);
            tools.push(tavilyRetrieveDeclaration as any);
            funcs[TAVILY_RETRIEVE_TOOL_NAME] = createTavilyRetrieveHandler();
          }
        }

        // separate SSE parsers for gpt-5 vs others
        const session = useChatStore.getState().currentSession();
        const sessionId = session?.id as string;

        let nextPrevId: string | undefined;

        const parseCompletionsSSE = (
          text: string,
          runTools: ChatMessageTool[],
        ) => {
          const json = JSON.parse(text);
          const choices = json.choices as Array<{
            delta: {
              content: string;
              tool_calls: ChatMessageTool[];
              reasoning_content?: string | null;
              reasoning?: string | null;
            };
          }>;

          if (!choices?.length) return { isThinking: false, content: "" };

          const tool_calls = choices[0]?.delta?.tool_calls;
          if (tool_calls?.length > 0) {
            const id = tool_calls[0]?.id;
            const args = tool_calls[0]?.function?.arguments;
            if (id) {
              index += 1;
              runTools.push({
                id,
                type: tool_calls[0]?.type,
                function: {
                  name: tool_calls[0]?.function?.name as string,
                  arguments: args,
                },
              });
            } else {
              // @ts-ignore
              runTools[index]["function"]["arguments"] += args;
            }
          }

          const reasoning =
            choices[0]?.delta?.reasoning ||
            choices[0]?.delta?.reasoning_content;
          const content = choices[0]?.delta?.content;

          if (
            (!reasoning || reasoning.length === 0) &&
            (!content || content.length === 0)
          ) {
            return { isThinking: false, content: "" };
          }

          if (reasoning && reasoning.length > 0) {
            return { isThinking: true, content: reasoning };
          } else if (content && content.length > 0) {
            return { isThinking: false, content };
          }
          return { isThinking: false, content: "" };
        };

        const parseGpt5SSE = (text: string, runTools: ChatMessageTool[]) => {
          // Responses API streaming events
          const json = JSON.parse(text);

          // capture final id on completion
          if (
            (json.type === "response.completed" ||
              json.event === "response.completed") &&
            (json.response?.id || json.id)
          ) {
            nextPrevId = json.response?.id || json.id;
            return { isThinking: false, content: "" };
          }

          // --- Function call handling ---
          // A new function_call output item was added
          if (
            json.type === "response.output_item.added" &&
            json.item?.type === "function_call"
          ) {
            index += 1;
            runTools.push({
              id: json.item.call_id || json.item.id,
              type: "function",
              function: {
                name: json.item.name,
                arguments: "",
              },
            });
            return { isThinking: false, content: "" };
          }

          // Incremental function call arguments
          if (
            json.type === "response.function_call_arguments.delta" &&
            typeof json.delta === "string"
          ) {
            if (index >= 0 && runTools[index]) {
              runTools[index].function!.arguments += json.delta;
            }
            return { isThinking: false, content: "" };
          }

          // Function call arguments complete (no action needed, finish() handles execution)
          if (json.type === "response.function_call_arguments.done") {
            return { isThinking: false, content: "" };
          }

          // reasoning deltas
          if (
            json.type === "response.reasoning_summary_text.delta" &&
            typeof json.delta === "string"
          ) {
            return { isThinking: true, content: json.delta };
          }

          // text deltas
          if (
            json.type === "response.output_text.delta" &&
            typeof json.delta === "string"
          ) {
            return { isThinking: false, content: json.delta };
          }

          // sometimes a non-delta (non streaming) complete or consolidated output chunk.
          if (Array.isArray(json.output)) {
            const msg = json.output.find((o: any) => o.type === "message");
            if (msg?.content) {
              const text = msg.content
                .filter(
                  (c: any) =>
                    c?.type === "output_text" && typeof c?.text === "string",
                )
                .map((c: any) => c.text)
                .join("");
              if (text) return { isThinking: false, content: text };
            }
          }

          return { isThinking: false, content: "" };
        };

        const parseSSE = isGpt5 ? parseGpt5SSE : parseCompletionsSSE;

        // wrap onFinish to stash the response id for gpt-5
        const originalOnFinish = options.onFinish;
        const wrappedOptions = {
          ...options,
          onFinish: (
            message: string,
            res: Response,
            thinkingText?: string,
            timingInfo?: TimingInfo,
          ) => {
            if (isGpt5 && nextPrevId) {
              originalOnFinish(
                message,
                res,
                thinkingText,
                timingInfo,
                nextPrevId,
              );
            } else {
              originalOnFinish(message, res, thinkingText, timingInfo);
            }
          },
        };

        // console.log("getAsTools", tools, funcs);
        streamWithThink(
          chatPath,
          requestPayload,
          getHeaders(false, modelConfig.providerName as ServiceProvider),
          tools as any,
          funcs,
          controller,
          parseSSE,
          (
            requestPayload: any,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // reset index value
            index = -1;

            if (isGpt5) {
              // Responses API: send function_call_output items as new input,
              // referencing the previous response for conversation continuity.
              const rp = requestPayload as ResponseRequestPayload;
              rp.input = toolCallResult.map((r) => ({
                type: "function_call_output" as const,
                call_id: r.tool_call_id,
                output:
                  typeof r.content === "string"
                    ? r.content
                    : JSON.stringify(r.content),
              }));
              // Chain off the response that produced the tool calls
              if (nextPrevId) {
                rp.previous_response_id = nextPrevId;
              }
              // Instructions are not persisted across turns via previous_response_id,
              // so they must remain in the payload on follow-up tool executions.
            } else {
              // Chat Completions: append assistant tool_calls + tool results to messages
              // @ts-ignore
              requestPayload?.messages?.splice(
                // @ts-ignore
                requestPayload?.messages?.length,
                0,
                toolCallMessage,
                ...toolCallResult,
              );
            }
          },
          wrappedOptions,
        );
      } else {
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(
            false,
            modelConfig.providerName as ServiceProvider,
          ),
        };

        // make a fetch request
        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          getTimeoutMSByModel(options.config.model),
        );

        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const newGpt5Id = isGpt5 && resJson?.id ? resJson.id : undefined;

        const message = await this.extractMessage(resJson);
        options.onFinish(message, res, undefined, undefined, newGpt5Id);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter(
      (m) => m.id.startsWith("gpt-") || m.id.startsWith("chatgpt-"),
    );
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    //由于目前 OpenAI 的 disableListModels 默认为 true，所以当前实际不会运行到这场
    let seq = 1000; //同 Constant.ts 中的排序保持一致
    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      sorted: seq++,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
        sorted: 1,
      },
    }));
  }
}
export { OpenaiPath };
