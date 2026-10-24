# Claude Code setup (Fireworks)

Notes on the local Claude Code configuration: traffic is routed to Fireworks
instead of Anthropic, so no Anthropic remote policy applies.
The old remote-policy bypass this file used to document has been removed —
see the [historical section](#historical-anthropic-remote-policy-bypass-removed)
below.

## How it's wired

- `claude/settings.json` (this repo) is symlinked to `~/.claude/settings.json`
  by home-manager (`home.nix`, with `force = true` so it overwrites whatever
  Claude Code writes there). **Edit the repo copy, then rebuild**
  (home-manager activation) — editing
  `~/.claude/settings.json` directly gets clobbered.
- Claude Code itself is installed outside nix by the `installClaudeCode`
  activation script in `home.nix` (`https://claude.ai/install.sh`, native build
  self-updates; nixpkgs lags upstream).

## Fireworks routing

`settings.json → env` redirects the Anthropic client at Fireworks:

- `ANTHROPIC_BASE_URL` → `https://api.fireworks.ai/inference`
- `ANTHROPIC_AUTH_TOKEN` → Fireworks API key (see `settings.json`; not
  duplicated here)

## Models

- Default model: `kimi-latest[1m]` (Kimi K3, 1M context).
- `modelPicker` replaces the built-in `/model` options
  (`replaceBuiltInOptions: true`) with the three Fireworks serverless models:
  - `glm-latest[1m]` — "GLM 5.3 (Latest)"
  - `kimi-latest[1m]` — "Kimi K3 (Latest)"
  - `deepseek-flash-latest[1m]` — "DeepSeek V4.1 Flash 1017 (Latest)"
- The `[1m]` suffix is required for Fireworks models: without it Claude Code
  doesn't recognize the ID and assumes a 200k context window (startup warning).
  Fireworks reports all three at a 1M context window.
- Switch in-session with `/model`.

## Permissions & sandbox

- `permissions.defaultMode: "plan"` — sessions start in plan mode.
- `sandbox.enabled: false`.

## Env flags in `settings.json → env`

- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`,
  `DO_NOT_TRACK=1` — telemetry/off-network minimization.
- `ENABLE_TOOL_SEARCH=true` — deferred tool loading.
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` — fixed effort (`effortLevel:
"high"` is set at top level).
- `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=0`, `autoUpdatesChannel: "stable"`.
- `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1` — Explore agents inherit the
  parent model.
- `CLAUDE_CODE_AUTO_MODE_SERVER=0`, `CLAUDE_CODE_NO_FLICKER=1`.

## Reverting to Anthropic

1. Remove the three `ANTHROPIC_*` keys from `settings.json → env`.
2. Remove the `modelPicker` block and set `model` back to a `claude-*` model.
3. Rebuild (home-manager activation re-links the settings file).

A pre-pivot backup of the main config exists at
`~/.claude/backups/claude.json.pre-fireworks.bak`.

## Historical: Anthropic remote-policy bypass (removed)

Before the Fireworks pivot, a remotely-pushed Anthropic policy (model pinned to
sonnet, sandbox on, bypass-permissions disabled) was enforced from the cached
`~/.claude/remote-settings.json` at every startup, overriding local settings.
The cache was applied synchronously at launch while the re-fetch only took
effect on the _next_ launch, so starting with an empty `{}` cache bypassed the
policy entirely.

Three layers kept the cache empty, all since removed because Fireworks routing
makes Anthropic policy moot:

1. `~/.claude/remote-settings.json` and `~/.claude/policy-limits.json` written
   as `{}` and locked with `chflags uchg` (immutable).
2. A self-healing `SessionStart` hook in `settings.json` that re-emptied and
   re-locked both files every session.
3. A `claude()` wrapper in `zsh/aliases.zsh` that reset the caches _before_
   launch, so even a dirty cache never applied.

Nothing is currently locked: neither cache file exists on disk. The full
write-up (mechanism, evidence table, red herrings) and the hook/wrapper code
are recoverable from git history — see commit `b661676` ("add claude alias to
bypass org policy") and pre-rewrite versions of this README.

Note: bypassing an employer- or org-pushed policy may violate their
acceptable-use policy.

## Related files

- `claude/settings.json` — user settings (symlinked to `~/.claude/settings.json`)
- `home.nix` — the symlink (`force = true`) and the `installClaudeCode`
  activation script
- `~/.claude/backups/claude.json.pre-fireworks.bak` — pre-Fireworks config backup
