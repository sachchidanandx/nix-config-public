/**
 * Footer layout extension.
 *
 * Wraps pi's built-in FooterComponent and rebuilds only its first line:
 *
 *   <plan-mode status>  ~/cwd (branch) • session              <nvim-bridge status>
 *
 * The plan-mode badge keeps its own colors; the right status is always drawn
 * in the footer's dim color so it matches the rest of the footer.
 *   ↑in ↓out R W $cost ctx%/window (auto)        (provider) model • thinking   <- built-in
 *   <remaining extension statuses>                                             <- built-in
 *
 * Statuses are placed by their ctx.ui.setStatus() key, so the producers stay
 * decoupled from this layout: without this extension they simply appear on
 * the built-in status line. Every line except the first is rendered by pi's
 * own FooterComponent so it stays identical to the default footer.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  FooterComponent,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Status shown left of the cwd. */
const LEFT_STATUS_KEY = "plan-mode";
/** Status right-aligned on the cwd line. */
const RIGHT_STATUS_KEY = "nvim-bridge";
const PLACED_STATUS_KEYS = new Set([LEFT_STATUS_KEY, RIGHT_STATUS_KEY]);

const BADGE_GAP = "  ";
const RIGHT_GAP = 2;
/** Columns of cwd kept visible before the right-hand status is dropped. */
const MIN_CWD_WIDTH = 12;

type FooterSession = ConstructorParameters<typeof FooterComponent>[0];
type FooterData = ConstructorParameters<typeof FooterComponent>[1];

/** Same normalization the built-in footer applies to extension statuses. */
function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Mirrors the built-in footer's `~` substitution for the working directory. */
function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const insideHome =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!insideHome) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * FooterComponent expects an AgentSession, which extensions cannot access.
 * It only reads the members below, all of which the extension API exposes.
 */
function createSessionAdapter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): FooterSession {
  const adapter = {
    get state() {
      return { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
    },
    get sessionManager() {
      return ctx.sessionManager;
    },
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: {
      isUsingSubscription(providerId: string): boolean {
        const model = ctx.model;
        if (!model || model.provider !== providerId) return false;
        const registry = ctx.modelRegistry;
        return (
          registry.isUsingOAuth(model) &&
          registry.getProvider(providerId)?.auth?.oauth?.isSubscription === true
        );
      },
    },
  };
  return adapter as unknown as FooterSession;
}

/** Footer data with the statuses this layout places itself removed from the built-in status line. */
function withoutPlacedStatuses(data: ReadonlyFooterDataProvider): FooterData {
  const filtered: ReadonlyFooterDataProvider = {
    getGitBranch: () => data.getGitBranch(),
    getAvailableProviderCount: () => data.getAvailableProviderCount(),
    onBranchChange: (callback) => data.onBranchChange(callback),
    getExtensionStatuses: () => {
      const statuses = new Map(data.getExtensionStatuses());
      for (const key of PLACED_STATUS_KEYS) statuses.delete(key);
      return statuses;
    },
  };
  return filtered as unknown as FooterData;
}

function readAutoCompactEnabled(ctx: ExtensionContext): boolean {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionEnabled();
  } catch {
    return true;
  }
}

function buildLocationText(
  ctx: ExtensionContext,
  data: ReadonlyFooterDataProvider,
): string {
  let text = formatCwd(
    ctx.sessionManager.getCwd(),
    process.env.HOME || process.env.USERPROFILE,
  );
  const branch = data.getGitBranch();
  if (branch) text = `${text} (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) text = `${text} • ${sessionName}`;
  return text;
}

/**
 * `<left>  <dim location>          <right>`
 *
 * Priority when narrow: the left badge is always kept, the location is
 * truncated next, and the right status is dropped once the location would
 * shrink below MIN_CWD_WIDTH.
 */
function renderTopLine(
  width: number,
  theme: Theme,
  location: string,
  left: string | undefined,
  rightText: string | undefined,
): string {
  const plainRight =
    rightText === undefined ? "" : stripTerminalSequences(rightText).trim();
  const right = plainRight ? theme.fg("dim", plainRight) : undefined;
  const prefix = left ? `${left}${BADGE_GAP}` : "";
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) return truncateToWidth(left ?? "", width);

  const rightWidth = right ? visibleWidth(right) : 0;
  const minLocation = Math.min(visibleWidth(location), MIN_CWD_WIDTH);
  const showRight =
    right !== undefined &&
    prefixWidth + minLocation + RIGHT_GAP + rightWidth <= width;

  const locationBudget =
    width - prefixWidth - (showRight ? rightWidth + RIGHT_GAP : 0);
  const locationText = truncateToWidth(
    theme.fg("dim", location),
    locationBudget,
    theme.fg("dim", "..."),
  );

  if (!showRight) return truncateToWidth(prefix + locationText, width);
  const padding = " ".repeat(
    Math.max(
      RIGHT_GAP,
      width - prefixWidth - visibleWidth(locationText) - rightWidth,
    ),
  );
  return truncateToWidth(prefix + locationText + padding + right, width);
}

function statusText(
  data: ReadonlyFooterDataProvider,
  key: string,
): string | undefined {
  const text = data.getExtensionStatuses().get(key);
  if (text === undefined) return undefined;
  const sanitized = sanitizeStatusText(text);
  return sanitized.length > 0 ? sanitized : undefined;
}

export default function footerLayout(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const autoCompactEnabled = readAutoCompactEnabled(ctx);

    // Re-installed on every session start so the closure never holds a stale ctx.
    ctx.ui.setFooter((tui, theme, footerData) => {
      const builtIn = new FooterComponent(
        createSessionAdapter(pi, ctx),
        withoutPlacedStatuses(footerData),
      );
      builtIn.setAutoCompactEnabled(autoCompactEnabled);
      const unsubscribeBranch = footerData.onBranchChange(() =>
        tui.requestRender(),
      );
      let lastLines: string[] = [];

      return {
        invalidate() {
          builtIn.invalidate();
        },
        dispose() {
          unsubscribeBranch();
          builtIn.dispose();
        },
        render(width: number): string[] {
          try {
            const lines = builtIn.render(width);
            lines[0] = renderTopLine(
              width,
              theme,
              buildLocationText(ctx, footerData),
              statusText(footerData, LEFT_STATUS_KEY),
              statusText(footerData, RIGHT_STATUS_KEY),
            );
            lastLines = lines;
            return lines;
          } catch {
            // The runtime can be torn down (reload, session switch) before the
            // replacement footer is installed; keep the last frame meanwhile.
            return lastLines.map((line) => truncateToWidth(line, width));
          }
        },
      };
    });
  });
}
