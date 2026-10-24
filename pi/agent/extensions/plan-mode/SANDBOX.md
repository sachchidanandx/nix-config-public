# Plan-mode sandbox

This document records the sandbox design **as accepted and shipped** (2026-10-01). It is the baseline for further work: change it together with the code, and add new decisions to the relevant section instead of rewriting history.

Code: [`sandbox.ts`](sandbox.ts) (profile and wrapping), [`bash-policy.ts`](bash-policy.ts) (side-effect policy), [`index.ts`](index.ts) (wiring), [`prompts.ts`](prompts.ts) (what the model is told).

---

## 1. Overview and threat model

Plan mode lets the model investigate and propose a plan; nothing should change until the user approves it. Since plan mode needs `bash` for investigation (`rg`, `git log`, `nix eval`, `gh pr view`, ...), bash is the main risk.

**Protects against** the model (by mistake or misjudgement) changing things before approval:

- files in the project, the home folder or the system (any program: redirects, `sed -i`, scripts, `git commit`, `npm install`, ...);
- external state: pushes, API writes, deploys, cloud and cluster changes;
- local services acting on the command's behalf: nix-daemon, launchd, cfprefsd, docker, other processes.

**Out of scope**

- Deliberately hostile code built to escape (for example poisoning a cache that an unsandboxed tool later reads; see [known gaps](#9-known-gaps-and-accepted-risks)).
- Commands the user runs with `!cmd`: they are the user's, not the model's, and are not sandboxed.
- Execute mode: after approval bash runs normally.
- Reading secrets: reads are not restricted.

## 2. Enforcement layers

In plan mode, in order:

| #   | Layer              | Where                                       | What it does                                                                                                                                                                                             |
| --- | ------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tool filtering     | `state.ts` (`planModeTools`, `WRITE_TOOLS`) | `edit`/`write` are removed from the active tools; `read`/`grep`/`find`/`ls` are added.                                                                                                                   |
| 2   | `tool_call` gate   | `index.ts`, `state.ts` (`READ_ONLY_TOOLS`)  | Blocks write tools; allows known read-only tools (codemode, MCP resource reads, slack/atlassian/chrome-devtools reads); asks before anything else; refuses bash when the sandbox is not usable.          |
| 3   | Side-effect policy | `bash-policy.ts`                            | Classifies the command line: **allow** (default), **ask** (listed side effect), **deny** (never in plan mode).                                                                                           |
| 4   | OS sandbox         | `sandbox.ts`, `spawnHook` in `index.ts`     | Every plan-mode bash command runs under the OS sandbox — Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux: read-only filesystem except scratch/temp/cache folders; tmux socket blocked. |
| 5   | Feedback           | bash `execute` wrapper in `index.ts`        | Appends a note when output shows `Operation not permitted` / `Read-only file system`; detects a broken sandbox and disables bash.                                                                        |

Layers 3 and 4 are complementary: the sandbox handles everything that writes files (whatever the program), the policy handles what the sandbox cannot see (network writes, service-mediated changes) and gives the model a reason up front.

### One bash call

```
model calls bash { command }
  │
  ├─ tool_call (index.ts)
  │    ├─ sandbox unavailable/broken? ──► block: "bash is disabled because …"
  │    ├─ classifyBashCommand(command, sessionApprovals)
  │    │    ├─ deny ──► block with reason
  │    │    ├─ ask  ──► dialog: Allow once / Allow <keys> for this session / Deny
  │    │    └─ allow
  │    ▼
  ├─ bash tool execute (index.ts wrapper → built-in createBashToolDefinition)
  │    ├─ command = shellCommandPrefix + "\n" + command          (built-in)
  │    ├─ spawnHook (mode === "plan"):
  │    │    macOS:  command = exec /usr/bin/sandbox-exec -p '<profile>' \
  │    │             -D HOME=<real home> -D TMPDIR=<real tmpdir> \
  │    │             <shellPath or /bin/bash> -c '<command>'
  │    │    Linux:  command = exec bwrap --ro-bind / / --dev /dev --proc /proc \
  │    │             --bind <writable> <writable>… \
  │    │             --ro-bind /dev/null <tmux socket>… \
  │    │             --die-with-parent -- <shellPath or /bin/bash> -c '<command>'
  │    │    env.GIT_OPTIONAL_LOCKS = 0
  │    ├─ spawn: <shell> -c '<wrapped>'                           (built-in)
  │    ▼
  └─ result
       ├─ output has "Operation not permitted" / "Read-only file system" ──► append sandbox note
       └─ sandbox failed to start (exit 65/71 + "sandbox-exec:", or exit 1 + "bwrap:") ──► mark broken, notify, disable bash
```

### MCP tools

MCP calls — direct or from a `codemode` script — pass through the same `tool_call` gate. `state.ts` (`READ_ONLY_MCP_TOOLS`) allow-lists the read-only tools of the configured servers so investigation does not prompt:

- **slack** (`mcp__slack__*`): searches, channel/thread/canvas/file/list reads, membership lists, reactions read. Posts, drafts, reaction adds, list/canvas writes and file uploads ask.
- **atlassian** (`mcp__atlassian__*`): issue/content getters, JQL/CQL/Rovo search, graph reads, `discover`, `executeRead`. `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, Confluence create/update, `addGraphContext`, `executeWrite`, `executeDestructive` ask.
- **chrome-devtools** (`mcp__chrome_devtools__*`): navigation and observation (pages, navigate, snapshot, screenshot, console, network, emulate, lighthouse, performance traces). Page interaction (`click`, `drag`, `fill`, `fill_form`, `type_text`, `press_key`, `handle_dialog`, `upload_file`), `evaluate_script`, `close_page` and `take_heapsnapshot` (requires an output path) ask.

`codemode` itself is allowed: the QuickJS VM has no file system, network or timers, and every inner call re-enters the gate (inner bash is classified and sandboxed; `edit`/`write` are not callable while filtered from the active tools). A server tool not in the list — new, renamed or write-capable — simply asks.

## 3. Sandbox primers

### 3a. sandbox-exec (macOS backend)

- **What it is.** `sandbox-exec` is the command-line front end of macOS's kernel sandbox, _Seatbelt_ (the same engine behind App Sandbox, Safari and Chrome's renderer sandbox). A profile written in SBPL (Sandbox Profile Language, Scheme-like) is compiled by libsandbox and enforced by the `Sandbox.kext` MAC policy: every file, network, IPC, process and sysctl operation is checked against it.
- **Inheritance.** The sandbox applies to the process and every child it starts, and cannot be removed from inside.
- **Denials.** A denied call fails with `EPERM`, printed as `Operation not permitted` (Python: `PermissionError: [Errno 1] Operation not permitted`). Violations are logged by the kernel (see [debugging](#11-testing-and-debugging)).
- **Operations and filters used here.** `file-write*` (create, write, delete, rename, chmod, ...), `network-outbound` with `(remote unix-socket (path-regex …))`; filters `literal`, `subpath`, `regex`; `(param "X")` values come from `-D X=…`.
- **Status.** The man page marks it _DEPRECATED_ (dated 2017) and points to App Sandbox; Apple has announced no removal date. SBPL is undocumented and may change without notice. It still works on macOS 26.7 (tested). Many tools depend on it: Nix's darwin build sandbox, Bazel, Chromium, Codex CLI, Claude Code, Gemini CLI.
- **Why it is the only option on macOS.**

  | Option                                             | Usable here?                                                                                                                                         |
  | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `sandbox-exec` / `sandbox_init()` (Seatbelt)       | **Yes**: any command, unsigned, per invocation.                                                                                                      |
  | App Sandbox                                        | Same engine, but only through entitlements on a signed `.app`.                                                                                       |
  | Endpoint Security                                  | Needs an Apple-granted entitlement and a signed system extension.                                                                                    |
  | bubblewrap                                         | Linux only (namespaces).                                                                                                                             |
  | Landlock                                           | Linux only (LSM, kernel 5.13+).                                                                                                                      |
  | Containers / VMs (Apple `container`, Docker, Lima) | Linux guests: no macOS tools, nix-darwin, keychain; slow per command.                                                                                |
  | `@anthropic-ai/sandbox-runtime`                    | Wraps `sandbox-exec` on macOS (bubblewrap on Linux) and adds a domain-filtering proxy; needs npm. A possible enhancement, not an alternative engine. |

- **References.** `man sandbox-exec`; system profiles in `/System/Library/Sandbox/Profiles/*.sb` and `/usr/share/sandbox/*.sb` (real-world SBPL examples).

### 3b. bubblewrap (Linux backend)

- **What it is.** `bwrap` is the low-level sandboxing tool of flatpak (also used by nix and `@anthropic-ai/sandbox-runtime`): an unprivileged setuid-free helper that creates a **user namespace + mount namespace** per invocation, arranges mounts inside it, drops privileges and execs the command. No daemon, no profile language, no compilation — a plain CLI, which is why it was chosen over Landlock (an LSM syscall API that would need a helper binary).
- **Mount model.** Instead of Seatbelt's "allow everything, deny writes", bwrap inverts it: the whole host filesystem is bind-mounted **read-only** (`--ro-bind / /`), then the writable paths are re-bound read-write on top (`--bind /tmp /tmp`, ...; later mounts override earlier ones at the same path). `--dev /dev` and `--proc /proc` mount a fresh devtmpfs and procfs; the fresh devtmpfs includes the `fd`/`stdin`/`stdout`/`stderr`/`ptmx` symlinks, so process substitution and `> /dev/stdout` (with a file-backed stdout) keep working.
- **Denials.** A denied write fails with `EROFS`, printed as `Read-only file system` (Python: `OSError: [Errno 30] Read-only file system`). There is no kernel violation log equivalent to `log stream`; the error message is the signal.
- **Network** is shared by default (no `--unshare-net`), matching the macOS backend's "network allowed".
- **Setup errors.** If bwrap cannot set up the sandbox (bad option, missing `--bind` source, namespaces denied) it exits 1 with stderr starting `bwrap:` — detected as a sandbox-broken error, fail closed.
- **Ubuntu AppArmor restriction.** Ubuntu restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`) but ships `/etc/apparmor.d/bwrap-userns-restrict`, which permits the **apt package's `/usr/bin/bwrap`** to create them. A nix/home-manager bwrap is not covered by that profile and fails; `sandboxBackend()` therefore **probes** bwrap with a real run and treats a failure as "sandbox unavailable" (fail closed). On Ubuntu, use `sudo apt install bubblewrap`.
- **Kill semantics.** `--die-with-parent` plus the `exec` prefix keep pi's abort/timeout process kill working.
- **References.** `man bwrap`; flatpak.

## 4. The profile (macOS backend)

Built by `buildProfile()` and passed inline with `-p`:

```scheme
(version 1)
(allow default)
;; Read-only filesystem, except scratch, temp and cache folders.
(deny file-write*)
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper")
  (literal "/dev/ptmx")
  (regex #"^/dev/fd/[0-9]+$")
  (regex #"^/dev/ttys[0-9]+$")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath (param "TMPDIR"))
  (subpath (string-append (param "HOME") "/.cache"))
  (subpath (string-append (param "HOME") "/Library/Caches"))
  (subpath (string-append (param "HOME") "/.npm"))
)
;; Sockets of servers that would run commands outside the sandbox.
(deny network-outbound (remote unix-socket (path-regex #"^/private/tmp/tmux-")))
```

| Rule                                      | Why                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `(allow default)`                         | Start from "everything allowed"; only writes are restricted. Reads, exec, network and IPC keep working. |
| `(deny file-write*)`                      | The read-only filesystem. Later rules win, so the allow list below re-opens specific paths.             |
| `/dev/null`                               | Discarding output. **Required by git**, which opens it read-write (`git log` fails without it).         |
| `/dev/zero`, `/dev/stdout`, `/dev/stderr` | Opened for writing by common tools and explicit redirects.                                              |
| `/dev/tty`, `/dev/ttys*`, `/dev/ptmx`     | Terminal prompts and pseudo-terminals.                                                                  |
| `/dev/dtracehelper`                       | Opened by dyld/node at startup.                                                                         |
| `/dev/fd/*`                               | Process substitution (`diff <(a) <(b)`) and fd redirects.                                               |
| `/private/tmp`                            | `/tmp` scratch files (`/tmp` is a symlink; the kernel matches real paths).                              |
| `/private/var/folders`                    | Default `$TMPDIR` (`/var/folders/…/T`), plus per-user caches (`…/C`) used by clang, xcrun, etc.         |
| `(param "TMPDIR")`                        | `$TMPDIR` when it is set outside `/var/folders`.                                                        |
| `~/.cache`                                | Tool caches: nix (flake/fetcher cache), uv, pre-commit, ...                                             |
| `~/Library/Caches`                        | macOS tool caches: go build cache, pip, Homebrew downloads, ...                                         |
| `~/.npm`                                  | npm writes `_logs` and `_cacache` even for `npm view` (found in the spike).                             |
| tmux socket deny                          | A sandboxed `tmux send-keys` / `run-shell` would run commands in the unsandboxed tmux server.           |

**Parameters** (`-D`), set per command by `sandboxParams(env)`:

- `HOME`: real path of `$HOME`;
- `TMPDIR`: real path of `$TMPDIR` (or `/tmp`), without the trailing slash.

Paths are resolved with `realpath` because Seatbelt matches canonical paths (`/var` → `/private/var`).

**Inline profile, not a file.** The profile is passed with `-p '<text>'`. A profile file would have to live somewhere readable at every call; anywhere writable from inside the sandbox (such as `$TMPDIR`) would let one sandboxed command rewrite it and lift the sandbox for the next. (The original plan wrote `$TMPDIR/pi-plan-sandbox-<pid>.sb`; this was changed during implementation for that reason.)

**Network** is not restricted: reads (`curl`, `gh … view`, `git ls-remote`, `nix eval` fetches, `npm view`) always work. Network _writes_ are the policy's job.

## 4b. Mount layout (Linux backend)

Built by `buildBwrapArgs()`; the seatbelt model maps to mounts as follows:

| Argument                       | Why                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--ro-bind / /`                | The read-only filesystem: the entire host `/`, read-only. The "deny file-write*" equivalent; denied writes fail with EROFS.                |
| `--dev /dev`                   | Fresh devtmpfs: writable `null`/`zero`/`tty`/`pts` plus `fd`/`stdin`/`stdout`/`stderr`/`ptmx` symlinks — covers every `/dev/*` rule above. |
| `--proc /proc`                 | Fresh procfs.                                                                                                                              |
| `--bind /tmp /tmp`             | Scratch files, read-write re-bind over the read-only `/`.                                                                                  |
| `--bind $TMPDIR $TMPDIR`       | When different from `/tmp` (deduped by canonical path).                                                                                    |
| `--bind ~/.cache ~/.cache`     | Tool caches (nix, uv, pre-commit, ...). Skipped when the directory does not exist — bwrap aborts on a missing `--bind` source.             |
| `--bind ~/.npm ~/.npm`         | npm's `_logs`/`_cacache`. Skipped when missing, same reason.                                                                               |
| `--ro-bind /dev/null <socket>` | Shadows each existing tmux server socket in `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/` so `connect()` fails. Best effort; see known gaps.          |
| `--die-with-parent`            | Kills the sandboxed command when pi exits.                                                                                                 |
| `-- <shell> -c <command>`      | The command itself.                                                                                                                        |

Same parameters as macOS come from `sandboxParams(env)` (canonical `home`/`tmpdir`). There is no inline profile to protect: the layout is argv, rebuilt per command. Network is shared (not restricted), as on macOS.

## 5. Command wrapping

- `index.ts` registers a tool named `bash` built with pi's `createBashToolDefinition`, so rendering, truncation, timeouts, `PI_*` environment variables and the system-prompt snippet are the built-in ones. The registered `execute` delegates to a definition rebuilt on every `session_start` with the user's settings (`SettingsManager.getShellCommandPrefix()` / `getShellPath()`, honouring project trust).
- Order inside the built-in: `shellCommandPrefix + "\n" + command` → `spawnHook` → `spawn(<shell>, ["-c", command])`. The prefix therefore runs **inside** the sandbox.
- The `spawnHook` only acts when `mode === "plan"`; in execute mode the command is untouched. If the sandbox is not usable it throws (backstop: bash never runs unsandboxed in plan mode even if the `tool_call` gate were bypassed).
- The two wrapped command lines (`wrapCommand`, dispatched on `sandboxBackend()` at load):
  - macOS: `exec /usr/bin/sandbox-exec -p '<profile>' -D HOME=… -D TMPDIR=… <shell> -c '<command>'`
  - Linux: `exec <bwrap from PATH> --ro-bind / / --dev /dev --proc /proc --bind <w> <w>… --ro-bind /dev/null <tmux socket>… --die-with-parent -- <shell> -c '<command>'`
- Quoting: every argument is single-quoted (`'` → `'\''`), so quotes, newlines, `$()` and backticks in the command reach the inner shell unchanged (tested).
- `exec` replaces the outer shell with the sandbox tool, so pi's process-tree kill on abort/timeout still reaches the command.
- `GIT_OPTIONAL_LOCKS=0` stops `git status` and friends from trying to refresh `.git/index` (a write that would fail).
- The inner shell is the configured `shellPath`, else `/bin/bash` (pi's default on macOS; present on Ubuntu).
- `!cmd` (user bash) does not go through the tool and is not sandboxed.

## 6. Side-effect policy

`classifyBashCommand(command, sessionApprovals)` in `bash-policy.ts`.

**Default: allow.** Unknown programs, scripts, interpreters and local writes are allowed: the sandbox makes file writes fail. The table lists only side effects the sandbox cannot see.

| Group                 | Asks for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| git                   | `push`, `send-email`, `lfs push`, `svn dcommit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Remote writes (and `git push` pushes before its local ref update fails).                                                                          |
| gh                    | any action not in the read list (`view`, `list`, `diff`, `checks`, `status`, `watch`, `search`, `download`, `checkout`, `clone`, ...); `gh api` with a non-GET method, fields/`--input` (implicit POST) or a GraphQL `mutation`; `gh auth` other than `status`/`token`; `gh browse`                                                                                                                                                                                                                                                                                                          | GitHub writes. `config`/`alias`/`extension` are local (sandboxed) and allowed. gh is allow-listed by action because it is almost entirely remote. |
| HTTP                  | `curl` with a non-GET/HEAD `-X`, `-d`/`--data*`/`--json`/`-F`/`--form` (unless `-G`), `-T`, `-K`; `wget` with `--post-*`/`--body-*`/non-GET `--method`; `http`/`https`/`xh` with a non-GET method or data items                                                                                                                                                                                                                                                                                                                                                                              | Requests that send data. Downloads to files are local (sandboxed).                                                                                |
| Remote shells         | `ssh`, `scp`, `sftp`, `mosh`, `telnet`, `nc`, `ncat`, `socat`, `rsync` with a `host:` path, `ssh-add` (not `-l`/`-L`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Commands on another host run outside the sandbox.                                                                                                 |
| Cloud / cluster       | `kubectl` non-read subcommands (reads: `get`, `describe`, `logs`, ...), `kubectl rollout`/`auth` changes; `helm install/upgrade/uninstall/rollback/test/push/registry`; `terraform`/`tofu apply/destroy/import/refresh/taint/untaint/force-unlock/login/logout`, `state` changes, `workspace new/delete`; `pulumi up/destroy/refresh/import/…`, stack/config changes; `aws` operations not starting with `describe`/`list`/`get`/`show`/`head`/… (`s3`: only `ls`/`presign` allowed); `gcloud`/`az` with a write verb (`create`, `delete`, `update`, `deploy`, `start`, `ssh`, `add-*`, ...) | Remote infrastructure changes.                                                                                                                    |
| Nix                   | `nix build` (without `--dry-run`), `nix profile` changes, `nix store gc/delete/repair/optimise/add…/sign`, `nix copy`, `nix upgrade-nix`, `nix-store --delete/--gc/--realise/…`, `nix-env -i/-e/-u/…`, `nix-collect-garbage`, `nix-channel` (not `--list`), `darwin-rebuild`, `nixos-rebuild`, `home-manager` (not `generations`/`packages`/`news`/…)                                                                                                                                                                                                                                        | Builds and store changes happen in nix-daemon, outside the sandbox.                                                                               |
| Packages / containers | `brew` non-read subcommands; `docker`/`podman` non-read subcommands (including `compose up`, `image rm`, `push`); `colima` changes; `publish`/`unpublish`/`deprecate`/`yank`/`owner`/`login`/`dist-tag`/`access`/`token` changes for `npm`/`pnpm`/`yarn`/`bun`/`cargo`/`uv`/`poetry`/`gem`; `twine upload`                                                                                                                                                                                                                                                                                   | Daemons and registries.                                                                                                                           |
| macOS / services      | `launchctl` changes, `defaults write/delete/import/rename`, `osascript`, `open`, `shortcuts run`, `security` keychain/trust changes, `crontab` (not `-l`), `at`, `systemctl` changes                                                                                                                                                                                                                                                                                                                                                                                                         | Done by launchd, cfprefsd, securityd or other apps.                                                                                               |
| Processes / privilege | `kill` (not `-l`), `pkill`, `killall`, `sudo`, `su`, `doas`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Signals and privilege changes.                                                                                                                    |
| Editors               | `code`/`codium`/`cursor`/`subl`/`zed`/`idea`/`emacsclient`/`mate` (except `--version`…), `nvim`/`vim` `--server`/`--remote*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | IPC into a running editor, which writes outside the sandbox.                                                                                      |

**Denied** (never in plan mode): `reboot`, `shutdown`, `halt`, `poweroff`; `tmux` other than `-V` (its socket is blocked, so it cannot work; the deny explains why); interactive editors (`vi`, `vim`, `nvim`, `nano`, `emacs`, ...) without `--headless`/`--batch`/`-es`, because they would wait for input.

**Nesting.** The command line is parsed (quotes, operators, heredocs, redirects), and these are classified recursively: `$(…)`, backticks, `<(…)`/`>(…)`, substitutions in unquoted heredoc bodies, `sh|bash|zsh|… -c '…'`, `eval …`, wrappers (`env`, `command`, `exec`, `nohup`, `time`, `nice`, `timeout`, `watch`, `xargs`, `caffeinate`, `stdbuf`), `find -exec/-execdir/-ok` and `fd -x/-X`. Program names are matched by basename (`/usr/bin/git push`). A program name coming from a variable or substitution (`$GIT push`) asks (`dynamic command`). Unparsable input (unterminated quotes, multi-line substitutions in heredocs) asks (`unparsed`). Nesting deeper than 6 asks.

**Session approvals.** Each ask item has a key (`git push`, `gh pr create`, `curl write`, `kubectl apply`, `ssh`, ...). "Allow … for this session" remembers the keys; they turn matching asks into allows, never override a deny, and reset on every `session_start`.

**Approved commands still run sandboxed.** Approval only covers the flagged side effect. For example an approved `gh pr create` works (network), an approved `nix build` builds but cannot create `./result`.

## 7. Fail-closed behaviour

There is no way to turn the sandbox off in plan mode (no flag, no command, no strict fallback, no unsandboxed retry).

| Situation                                                                                                                                                               | Detection                                                                 | Model sees                                                                                                                                                                                                       | User sees                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `sandbox-exec` missing (not macOS, or removed by Apple); bwrap missing or probe fails (not installed, or AppArmor-denied userns — e.g. a nix-installed bwrap on Ubuntu) | `sandboxBackend()` at load (probes bwrap with a real run)                 | every bash call blocked: "bash is disabled because the plan-mode sandbox (sandbox-exec on macOS, bubblewrap on Linux) is not available on this machine. Continue with read, grep, find and ls, or ask the user." | one warning, when plan mode starts or bash is first refused |
| Profile fails to load / shell cannot start (macOS)                                                                                                                      | exit 65 or 71 and output starting with `sandbox-exec:` (`isProfileError`) | that call's output plus "The sandbox failed to start, so bash is disabled while planning…"; later calls blocked as above                                                                                         | one warning; resets on the next `session_start`             |
| bwrap fails at runtime (bad args, missing bind source)                                                                                                                  | exit 1 and output starting with `bwrap:` (`isProfileError`)               | same broken-sandbox path as above                                                                                                                                                                                | one warning; resets on the next `session_start`             |

Execute mode is unaffected in both cases. The rationale: the policy only allows unknown commands because the sandbox exists; running them without it would silently drop the file protection.

## 8. Spike results

### macOS

Run on 2026-10-01, macOS 26.7 (25G229), `/usr/bin/sandbox-exec`, with the profile above and `GIT_OPTIONAL_LOCKS=0`.

**Works:** `rg`; `git status/log/diff/stash list/ls-remote`; `git -C <other repo> log`; `nix eval --expr`; `nix eval nixpkgs#hello.version` (fetches into `~/.cache/nix`); `nix flake metadata`; `nix build --dry-run`; `gh api user`; `gh pr list` (in a GitHub repo); `jq`; `curl` GET (`-o /dev/null` and `-o /tmp/…`); `npm view` (after adding `~/.npm`); `python3 -c`, `node -e`; `uv run --with six` (cache in `~/.cache/uv`); `xcrun --show-sdk-path`; `cc -o /tmp/…` and running the result; `go env`; `defaults read`; `pbpaste`; `security find-generic-password`; `ssh` (network); `diff <(…) <(…)`; heredocs and here-strings; `echo >&2`, `> /dev/stdout`.

**Writable:** `/tmp/…`, `mktemp`, `$TMPDIR/…`, `~/.cache/…`, `tee /tmp/…`, `curl -o /tmp/…`.

**Blocked (`Operation not permitted`):** `touch`, `echo >`, `sed -i` and Python `open(…, 'w')` in the project; `touch ~/x`; `mkdir ~/.config/x`; `git fetch` (cannot lock refs in `.git`); `tmux ls` (socket `/private/tmp/tmux-501/default`).

**Added because of the spike:** `~/.npm`.

**sandbox-exec's own errors:** exit 65 with `sandbox-exec: …` for a bad profile, a missing profile file or a missing `-D` parameter; exit 71 with `sandbox-exec: execvp() of '…' failed` when the command cannot be started.

### Linux (Ubuntu 26.04, bubblewrap)

Run on 2026-10-12, Ubuntu 26.04 (kernel 7.0, aarch64), apt `bubblewrap` 0.11.1 (`/usr/bin/bwrap`), with the §4b layout and `GIT_OPTIONAL_LOCKS=0`. From the `bwrap (live)` unit tests and the manual smoke runs in §11:

**Works:** `rg`; `git status`/`log`/`diff`; `curl -sI https://example.com` (200, network shared); `diff <(…) <(…)` (process substitution); `> /dev/stdout` when stdout is a file; reads under `/etc` and `$HOME`; scratch writes under `/tmp`/`$TMPDIR`.

**Blocked (`Read-only file system`):** `touch`/`echo >` in the project directory and in `$HOME`. **tmux:** `tmux ls` fails with "no server running on /tmp/tmux-501/default" while a server is up — the socket is shadowed by `/dev/null`.

**Notable difference from macOS:** re-opening an _inherited pipe_ through `/dev/stdout` (i.e. `/proc/self/fd/1`) fails with `ENXIO` (`No such device or address`) inside the user namespace — kernel pipefs is per-userns, so the pipe created by pi before spawning the command belongs to the parent namespace's pipefs. Pipes created _inside_ the sandbox (process substitution) work. This affects only the explicit `> /dev/stdout` idiom when stdout is a pipe.

## 9. Known gaps and accepted risks

- **Network writes from scripts and interpreters.** `python3 -c "requests.post(…)"`, a `make` recipe that pushes, an npm script calling an API: the policy only sees the command line. The prompt tells the model not to do this.
- **Services not blocked by socket.** nix-daemon (needed by `nix eval`) and cfprefsd (needed by `defaults read`) are reachable; only the listed commands (`nix build`, `defaults write`, ...) are caught. Incidental daemon work (`nix run`/`nix shell` building or substituting store paths) is allowed.
- **Writable caches are shared with unsandboxed tools.** A sandboxed command could leave content in `~/.cache`, `~/Library/Caches`, `~/.npm` (including `_npx`) or `/tmp` that an unsandboxed tool later uses. Acceptable under the threat model (no deliberately hostile code).
- **Local writes by network tools fail.** `git fetch`/`git pull` (update `.git`), `gh repo clone` into the project, `terraform init` (writes `.terraform`). The sandbox note explains it; the prompt suggests `git ls-remote` / `gh`.
- **Dependence on `sandbox-exec`.** Deprecated and undocumented; if it disappears or SBPL changes, plan mode loses bash (fail closed) until this is updated.
- **No read restrictions.** Secrets (`~/.ssh`, `~/.aws`, `.env`) are readable, and could be sent over the network by a command the policy allows.
- **Other tmux socket locations.** macOS: only `/private/tmp/tmux-*` is blocked (a custom `TMUX_TMPDIR` is not). Linux: shadowing is best-effort — only sockets existing at wrap time in `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/` are covered; sockets created later or under a custom `tmux -L` directory escape. `screen` and other multiplexers are not blocked on either platform. `bash-policy.ts` denies `tmux` outright regardless.
- **Linux denial wording differs.** bwrap denials are EROFS (`Read-only file system`), not EPERM; both are recognised for the sandbox note.
- **Linux: Ubuntu needs the apt bwrap.** With `kernel.apparmor_restrict_unprivileged_userns=1`, only the AppArmor-covered `/usr/bin/bwrap` (apt `bubblewrap` package) can create user namespaces; a nix/home-manager bwrap fails the probe and bash is refused (fail closed).
- **Linux: inherited pipes via `/dev/stdout`.** `echo x > /dev/stdout` fails with ENXIO when stdout is a pipe created outside the sandbox (kernel pipefs is per-userns); file-backed stdout and in-sandbox pipes are unaffected. A command that prints a first line starting with `bwrap:` and exits 1 is misread as a sandbox failure (fail closed), same risk class as the seatbelt heuristic.
- **Linux: backend probed once at load.** Installing bwrap mid-session needs a pi restart (the probe result is cached).
- **Heuristic parsing.** The policy recognises flags by name; exotic spellings or tools not in the table pass. Unknown-but-risky tools should be added to the table.
- **MCP tools with optional output paths.** Whitelisted browser tools whose `filePath` is optional (`take_screenshot`, `performance_stop_trace`) can write a file anywhere the MCP server process can — outside the sandbox. `take_heapsnapshot`, which requires a path, still asks. Server-declared `readOnlyHint` annotations are not trusted for classification; the allow-list is explicit.

## 10. Enhancement backlog

Candidates, not commitments:

- **Domain allow-list for the network** through a local proxy (as `@anthropic-ai/sandbox-runtime` does), turning "network reads allowed" into "reads to allowed hosts".
- **Read restrictions** for `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env*` (`(deny file-read* …)`), with care for tools that need them (git over ssh, aws reads).
- **Per-project config** `.pi/sandbox.json` for extra writable paths (the `extraWritable` argument of `buildProfile` already exists).
- **`git fetch` support** by fetching into a temporary clone or `GIT_DIR` copy under `$TMPDIR`.
- **Block docker/podman/colima sockets** at the profile level (then docker reads would need an ask).
- **Optional sandbox in execute mode** (for example writable project folder, read-only home).
- **Violation logging**: surface kernel denials (`log stream`) instead of relying on `Operation not permitted` in the output.
- **`/plan sandbox` status command** showing availability and the active profile (read-only; no off switch).

## 11. Testing and debugging

**Run a command under the macOS profile by hand**

```sh
cd ~/nix-config
node -e 'import("./pi/agent/extensions/plan-mode/sandbox.ts").then(m => process.stdout.write(m.buildProfile()))' > /tmp/plan.sb
sandbox-exec -f /tmp/plan.sb -D HOME="$(realpath ~)" -D TMPDIR="$(realpath "$TMPDIR")" /bin/bash -c 'touch x; echo $?'
```

(A file is fine for manual testing; the extension itself passes the profile inline.)

**See what the kernel denied**

```sh
log stream --style compact --predicate 'sender=="Sandbox"'
```

**Run a command under the Linux backend by hand**

```sh
cd ~/nix-config
node -e 'import("./pi/agent/extensions/plan-mode/sandbox.ts").then(m => console.log(m.wrapCommand("touch x; echo $?", { shell: "/bin/bash", params: m.sandboxParams(), backend: "bwrap" })))' | sh
```

Denied writes print `Read-only file system`; there is no `log stream` equivalent — the error message is the signal.

**Unit tests**

```sh
node --test pi/agent/extensions/plan-mode/*.test.ts
```

- `sandbox.test.ts`: profile text, bwrap arg layout, quoting (quotes, newlines, `$()`, backticks), error detection, and live runs per backend — `sandbox-exec (live)` (scratch write works, home write blocked, broken profile detected) gated on macOS, `bwrap (live)` (scratch write works, home/project writes blocked with EROFS, fresh `/dev`) gated on a working bwrap; each is skipped when its backend is unavailable.
- `bash-policy.test.ts`: allowed reads and local writes, every side-effect group, denies, nesting, session approvals, parser.

**End to end.** A scripted fake provider and a pty harness (kept outside the repo, in `/tmp/pi-e2e` during development) drive `pi` through plan-mode bash calls: scratch writes, blocked project writes with the note, network reads, asks, approvals staying sandboxed, fail-closed with a broken profile, execute mode unsandboxed.

**Checklist for changing the profile**

1. Edit `SAFE_WRITE_PATHS` / `BLOCKED_SOCKETS` in `sandbox.ts` (with a `why`).
2. Run the manual command above for the affected tools, and the unit tests.
3. Update the profile text, the rule table and, if a spike was done, the spike results here.
4. If the writable locations change, update `SANDBOX_WRITABLE` in `index.ts` and the bash line of `PLAN_MODE_SECTION` in `prompts.ts`.

## 12. File map

| File                  | Contents                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox.ts`          | Both backends: `SAFE_WRITE_PATHS`, `BLOCKED_SOCKETS`, `buildProfile` (macOS); `sandboxBackend`, `findOnPath`, `bwrapWritablePaths`, `bwrapBlockedSockets`, `buildBwrapArgs` (Linux); `shellQuote`, `sandboxParams`, `sandboxAvailable`; `wrapCommand`, `isProfileError` dispatch on the backend; `isSandboxDenial` accepts EPERM and EROFS |
| `sandbox.test.ts`     | Profile, quoting, error detection, live sandbox runs                                                                                                                                                                                                                                                                                       |
| `bash-policy.ts`      | Shell lexer (`parseCommandLine`), side-effect table (`RULES`), wrappers and nesting, `classifyBashCommand`                                                                                                                                                                                                                                 |
| `bash-policy.test.ts` | Policy and parser tests                                                                                                                                                                                                                                                                                                                    |
| `index.ts`            | `createBash` (definition + `spawnHook`), the registered `bash` tool and its `execute` wrapper (note, broken-sandbox detection), the `tool_call` gate (fail closed, deny, ask dialog), `SANDBOX_WRITABLE` / `SANDBOX_NOTE`, notices                                                                                                         |
| `prompts.ts`          | `PLAN_MODE_SECTION`: what the model is told about the sandbox and scratch folders                                                                                                                                                                                                                                                          |
| `state.ts`            | `WRITE_TOOLS`, `READ_ONLY_TOOLS`, `READ_ONLY_MCP_TOOLS`, plan-mode tool sets                                                                                                                                                                                                                                                               |
