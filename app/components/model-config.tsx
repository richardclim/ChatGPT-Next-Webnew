import { ServiceProvider } from "@/app/constant";
import { ModalConfigValidator, ModelConfig } from "../store";
import styles from "./model-config.module.scss";

import Locale from "../locales";
import { InputRange } from "./input-range";
import { ListItem, showPrompt } from "./ui-lib";
import { IconButton } from "./button";
import { ModelSelect } from "./model-select";
import type { GroupedModels } from "./model-select";
import { useAllModels } from "../utils/hooks";
import { groupBy } from "lodash-es";
import { getModelProvider } from "../utils/model";
import {
  getModelMaxOutputTokens,
  getModelEffortLevels,
} from "../utils/model-utils";
import EditIcon from "../icons/edit.svg";

/**
 * Inline effort dropdown shown next to a model selector when the
 * selected model supports reasoning effort levels.
 * Includes a small (i) info badge with a CSS-only tooltip.
 */
function EffortSelect(props: {
  model: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const levels = getModelEffortLevels(props.model);
  if (!levels) return null;

  return (
    <>
      <select
        aria-label={Locale.Settings.ReasoningEffort.Title}
        className={styles["effort-select"]}
        value={props.value || ""}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">Default (highest)</option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <span className={styles["effort-info"]}>
        <button
          type="button"
          className={styles["effort-info-btn"]}
          aria-label={Locale.Settings.ReasoningEffort.SubTitle}
          tabIndex={0}
        >
          i
        </button>
        <span className={styles["effort-tooltip"]} role="tooltip">
          {Locale.Settings.ReasoningEffort.SubTitle}
        </span>
      </span>
    </>
  );
}

export function ModelConfigList(props: {
  modelConfig: ModelConfig;
  updateConfig: (updater: (config: ModelConfig) => void) => void;
}) {
  const allModels = useAllModels();
  const groupModels = groupBy(
    allModels.filter((v) => v.available),
    "provider.providerName",
  ) as unknown as GroupedModels;
  const value = `${props.modelConfig.model}@${props.modelConfig?.providerName}`;
  const compressModelValue = `${props.modelConfig.compressModel}@${props.modelConfig?.compressProviderName}`;
  const modelMaxTokens = getModelMaxOutputTokens(props.modelConfig.model);

  return (
    <>
      <ListItem title={Locale.Settings.Model}>
        <div className={styles["model-effort-row"]}>
          <ModelSelect
            aria-label={Locale.Settings.Model}
            value={value}
            models={groupModels}
            onChange={(val) => {
              const [model, providerName] = getModelProvider(val);
              props.updateConfig((config) => {
                const oldModelMax = getModelMaxOutputTokens(config.model);
                config.model = ModalConfigValidator.model(model);
                config.providerName = providerName as ServiceProvider;
                const newModelMax = getModelMaxOutputTokens(model);
                if (config.max_tokens > newModelMax) {
                  config.max_tokens = newModelMax;
                } else if (
                  newModelMax > oldModelMax &&
                  config.max_tokens < newModelMax
                ) {
                  config.max_tokens = newModelMax;
                }
                // Reset effort when switching models
                config.reasoningEffort = "";
              });
            }}
          />
          <EffortSelect
            model={props.modelConfig.model}
            value={props.modelConfig.reasoningEffort}
            onChange={(v) =>
              props.updateConfig((config) => {
                config.reasoningEffort = v;
              })
            }
          />
        </div>
      </ListItem>
      <ListItem
        title={Locale.Settings.Temperature.Title}
        subTitle={Locale.Settings.Temperature.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.Temperature.Title}
          value={props.modelConfig.temperature?.toFixed(1)}
          min="0"
          max="1"
          step="0.1"
          onChange={(e) => {
            props.updateConfig(
              (config) =>
                (config.temperature = ModalConfigValidator.temperature(
                  e.currentTarget.valueAsNumber,
                )),
            );
          }}
        ></InputRange>
      </ListItem>
      <ListItem
        title={Locale.Settings.TopP.Title}
        subTitle={Locale.Settings.TopP.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.TopP.Title}
          value={(props.modelConfig.top_p ?? 1).toFixed(1)}
          min="0"
          max="1"
          step="0.1"
          onChange={(e) => {
            props.updateConfig(
              (config) =>
                (config.top_p = ModalConfigValidator.top_p(
                  e.currentTarget.valueAsNumber,
                )),
            );
          }}
        ></InputRange>
      </ListItem>
      <ListItem
        title={Locale.Settings.MaxTokens.Title}
        subTitle={Locale.Settings.MaxTokens.SubTitle}
      >
        <input
          aria-label={Locale.Settings.MaxTokens.Title}
          type="number"
          min={0}
          max={modelMaxTokens}
          value={props.modelConfig.max_tokens || ""}
          placeholder={Locale.Settings.MaxTokens.Placeholder}
          className={styles["max-tokens-input"]}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.max_tokens = ModalConfigValidator.max_tokens(
                  e.currentTarget.valueAsNumber,
                  modelMaxTokens,
                )),
            )
          }
        ></input>
      </ListItem>

      {props.modelConfig?.providerName == ServiceProvider.Google ? null : (
        <>
          <ListItem
            title={Locale.Settings.PresencePenalty.Title}
            subTitle={Locale.Settings.PresencePenalty.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.PresencePenalty.Title}
              value={props.modelConfig.presence_penalty?.toFixed(1)}
              min="-2"
              max="2"
              step="0.1"
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.presence_penalty =
                      ModalConfigValidator.presence_penalty(
                        e.currentTarget.valueAsNumber,
                      )),
                );
              }}
            ></InputRange>
          </ListItem>

          <ListItem
            title={Locale.Settings.FrequencyPenalty.Title}
            subTitle={Locale.Settings.FrequencyPenalty.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.FrequencyPenalty.Title}
              value={props.modelConfig.frequency_penalty?.toFixed(1)}
              min="-2"
              max="2"
              step="0.1"
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.frequency_penalty =
                      ModalConfigValidator.frequency_penalty(
                        e.currentTarget.valueAsNumber,
                      )),
                );
              }}
            ></InputRange>
          </ListItem>

          <ListItem
            title={Locale.Settings.InputTemplate.Title}
            subTitle={Locale.Settings.InputTemplate.SubTitle}
          >
            <input
              aria-label={Locale.Settings.InputTemplate.Title}
              type="text"
              value={props.modelConfig.template}
              onChange={(e) =>
                props.updateConfig(
                  (config) => (config.template = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>
        </>
      )}
      <ListItem
        title={Locale.Settings.HistoryCount.Title}
        subTitle={Locale.Settings.HistoryCount.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.HistoryCount.Title}
          title={props.modelConfig.historyMessageCount.toString()}
          value={props.modelConfig.historyMessageCount}
          min="0"
          max="64"
          step="1"
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.historyMessageCount = e.target.valueAsNumber),
            )
          }
        ></InputRange>
      </ListItem>

      <ListItem
        title={Locale.Settings.CompressThreshold.Title}
        subTitle={Locale.Settings.CompressThreshold.SubTitle}
      >
        <input
          aria-label={Locale.Settings.CompressThreshold.Title}
          type="number"
          min={500}
          max={4000}
          value={props.modelConfig.compressMessageLengthThreshold}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.compressMessageLengthThreshold =
                  e.currentTarget.valueAsNumber),
            )
          }
        ></input>
      </ListItem>

      <ListItem
        title={Locale.Settings.InjectSystemPrompts.Title}
        subTitle={Locale.Settings.InjectSystemPrompts.SubTitle}
      >
        <input
          aria-label={Locale.Settings.InjectSystemPrompts.Title}
          type="checkbox"
          checked={props.modelConfig.enableInjectSystemPrompts}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.enableInjectSystemPrompts = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>

      <ListItem
        title={Locale.Settings.SystemPrompt.Title}
        subTitle={Locale.Settings.SystemPrompt.SubTitle}
      >
        <IconButton
          aria={Locale.Settings.SystemPrompt.Edit}
          icon={<EditIcon />}
          text={Locale.Settings.SystemPrompt.Edit}
          onClick={async () => {
            const newPrompt = await showPrompt(
              Locale.Settings.SystemPrompt.Title,
              props.modelConfig.systemPrompt,
              10,
            );
            if (newPrompt !== undefined) {
              props.updateConfig((config) => (config.systemPrompt = newPrompt));
            }
          }}
        />
      </ListItem>

      <ListItem title={Locale.Memory.Title} subTitle={Locale.Memory.Send}>
        <input
          aria-label={Locale.Memory.Title}
          type="checkbox"
          checked={props.modelConfig.sendMemory}
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.sendMemory = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>

      <ListItem
        title={Locale.Settings.PromptOptimizer.Instructions}
        subTitle={Locale.Settings.PromptOptimizer.InstructionsSubTitle}
      >
        <IconButton
          aria={Locale.Settings.PromptOptimizer.Edit}
          icon={<EditIcon />}
          text={Locale.Settings.PromptOptimizer.Edit}
          onClick={async () => {
            const newInstructions = await showPrompt(
              Locale.Settings.PromptOptimizer.Edit,
              props.modelConfig.promptOptimizerInstructions,
              10,
            );
            if (newInstructions !== undefined) {
              props.updateConfig(
                (config) =>
                  (config.promptOptimizerInstructions = newInstructions),
              );
            }
          }}
        />
      </ListItem>

      <ListItem
        title={Locale.Settings.PromptOptimizer.Model}
        subTitle={Locale.Settings.PromptOptimizer.ModelSubTitle}
      >
        <div className={styles["model-effort-row"]}>
          <ModelSelect
            aria-label={Locale.Settings.PromptOptimizer.Model}
            value={`${props.modelConfig.promptOptimizerModel}@${props.modelConfig?.promptOptimizerProviderName}`}
            models={groupModels}
            placeholder={Locale.Settings.PromptOptimizer.SelectModel}
            onChange={(val) => {
              const [model, providerName] = getModelProvider(val);
              props.updateConfig((config) => {
                config.promptOptimizerModel = ModalConfigValidator.model(model);
                config.promptOptimizerProviderName =
                  (providerName as ServiceProvider) || ServiceProvider.OpenAI;
                config.promptOptimizerReasoningEffort = "";
              });
            }}
          />
          <EffortSelect
            model={props.modelConfig.promptOptimizerModel}
            value={props.modelConfig.promptOptimizerReasoningEffort}
            onChange={(v) =>
              props.updateConfig((config) => {
                config.promptOptimizerReasoningEffort = v;
              })
            }
          />
        </div>
      </ListItem>
      <ListItem
        title={Locale.Settings.CompressModel.Title}
        subTitle={Locale.Settings.CompressModel.SubTitle}
      >
        <div className={styles["model-effort-row"]}>
          <ModelSelect
            aria-label={Locale.Settings.CompressModel.Title}
            value={compressModelValue}
            models={groupModels}
            placeholder={Locale.Settings.CompressModel.SelectModel}
            onChange={(val) => {
              const [model, providerName] = getModelProvider(val);
              props.updateConfig((config) => {
                config.compressModel = ModalConfigValidator.model(model);
                config.compressProviderName = providerName as ServiceProvider;
                config.compressModelReasoningEffort = "";
              });
            }}
          />
          <EffortSelect
            model={props.modelConfig.compressModel}
            value={props.modelConfig.compressModelReasoningEffort}
            onChange={(v) =>
              props.updateConfig((config) => {
                config.compressModelReasoningEffort = v;
              })
            }
          />
        </div>
      </ListItem>
    </>
  );
}
