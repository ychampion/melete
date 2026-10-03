/**
 * One attempt's context budget, held to every limit that applies to it.
 *
 * The contract scales the budgets with the model's window. Here that window is
 * narrowed by what the operator states for the deployment and by the job's own
 * input ceiling, and the transcript by the compaction trigger the engine will
 * actually be configured with, read the same way the engine launchers read it.
 */
import { type ContextBudget, contextBudget } from '@melete/contracts';
import {
  compactionThresholdTokens,
  engineContextWindow,
  engineSettingsFromEnvironment,
} from '@melete/runtime-hermes';

type EngineSettings = ReturnType<typeof engineSettingsFromEnvironment>;

let settings: EngineSettings | undefined;

/** The operator's engine settings, read once; the launchers validate the same values. */
function engineSettings(): EngineSettings {
  settings ??= engineSettingsFromEnvironment();
  return settings;
}

/** For tests: forget the settings read from the environment. */
export function resetAttemptContextSettings(): void {
  settings = undefined;
}

export function attemptContextBudget(
  model: string,
  jobBudget: { max_input_tokens?: number } = {},
  environment?: EngineSettings,
): ContextBudget {
  const { compactionMaxTokens, contextWindowLimit } = environment ?? engineSettings();
  // The lower trigger of the two vision cases, so a screenshot-reading model's
  // reserve for pictures is never counted as room for the transcript.
  const compactionTokens = compactionThresholdTokens({
    contextWindow: engineContextWindow(model, contextWindowLimit),
    compactionMaxTokens,
    vision: true,
  });
  return contextBudget(model, {
    statedWindow: contextWindowLimit,
    maxInputTokens: jobBudget.max_input_tokens,
    compactionTokens,
  });
}
