/**
 * Default model per mode, from settings.json:
 *
 *   "planMode": {
 *     "plan":    { "model": "fireworks/accounts/fireworks/routers/kimi-latest", "thinking": "high" },
 *     "execute": { "model": "fireworks/accounts/fireworks/routers/glm-latest", "thinking": "high" }
 *   }
 *
 * `model` is an exact "provider/modelId" reference (the provider is the part
 * before the first "/"; model ids may contain "/"); `thinking` is optional.
 * Entering a mode switches to its default; ctrl+p still cycles pi's scoped
 * models (enabledModels) until the next mode switch.
 *
 * Pure helpers only (no pi runtime imports), so node --test can run them.
 */

import type { Mode } from "./state.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface ModeDefault {
  provider: string;
  id: string;
  thinking?: Thinking;
}

export type ModeDefaults = Partial<Record<Mode, ModeDefault>>;

const MODES: readonly Mode[] = ["plan", "execute"];

const isThinking = (value: unknown): value is Thinking =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/**
 * `planMode.plan` / `planMode.execute` from pi.getSettings(). Malformed
 * entries are skipped (a bad `thinking` only drops the thinking level) and
 * described in `problems` so the caller can warn.
 */
export function readModeDefaults(settings: unknown): { defaults: ModeDefaults; problems: string[] } {
  const defaults: ModeDefaults = {};
  const problems: string[] = [];
  const planMode = (settings as { planMode?: unknown } | null | undefined)?.planMode;
  if (typeof planMode !== "object" || planMode === null) return { defaults, problems };
  for (const mode of MODES) {
    const entry = (planMode as Record<string, unknown>)[mode];
    if (entry === undefined) continue;
    const model = typeof entry === "object" && entry !== null ? (entry as { model?: unknown }).model : undefined;
    const ref = typeof model === "string" ? model.trim() : "";
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      problems.push(`planMode.${mode}.model must be "provider/modelId"`);
      continue;
    }
    const target: ModeDefault = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
    const thinking = (entry as { thinking?: unknown }).thinking;
    if (isThinking(thinking)) target.thinking = thinking;
    else if (thinking !== undefined) problems.push(`planMode.${mode}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    defaults[mode] = target;
  }
  return { defaults, problems };
}

/** A session with no user message yet: new, or the fresh session created to execute a plan. */
export function isFreshSession(branch: readonly unknown[]): boolean {
  return !branch.some((entry) => {
    const e = entry as { type?: string; message?: { role?: string } };
    return e.type === "message" && e.message?.role === "user";
  });
}

/** --model / --provider on the command line: the user chose the startup model explicitly. */
export function modelFlagGiven(argv: readonly string[]): boolean {
  return argv.some((arg) => /^--(model|provider)(=|$)/.test(arg));
}
