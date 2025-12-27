import {
  DEFAULT_INPUT_TEMPLATE,
  KnowledgeCutOffDate,
} from "../constant";
import { ModelConfig } from "./config";
import { LLMModel } from "../client/api";

export function fillTemplateWith(
  input: string,
  modelConfig: ModelConfig,
  allModels: LLMModel[],
  lang: string
) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;

  // Find the model in the allModels array that matches the modelConfig.model
  const modelInfo = allModels.find((m) => m.name === modelConfig.model);

  var serviceProvider = modelConfig.providerName || "OpenAI";
  if (modelInfo?.provider?.providerName) {
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: lang,
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}
