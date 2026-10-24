/**
 * OS sandbox for bash in plan mode: Seatbelt (sandbox-exec) on macOS,
 * bubblewrap (bwrap) on Linux.
 *
 * macOS: every plan-mode bash command runs as
 *   exec /usr/bin/sandbox-exec -p '<profile>' -D HOME=… -D TMPDIR=… <shell> -c '<command>'
 * under a profile that allows everything except file writes outside
 * SAFE_WRITE_PATHS (scratch, temp and cache folders), and blocks the tmux
 * server socket. Network access is allowed.
 *
 * The profile is passed inline (-p), never as a file: sandboxed commands can
 * write to the temp folders, so a profile file there could be rewritten by
 * one command to lift the sandbox for the next.
 *
 * Linux: every plan-mode bash command runs as
 *   exec bwrap --ro-bind / / --dev /dev --proc /proc --bind <w> <w>… --die-with-parent -- <shell> -c '<command>'
 * The whole host filesystem is bind-mounted read-only, then scratch/temp
 * cache folders are re-bound read-write, existing tmux server sockets are
 * shadowed with /dev/null, and the network is shared (allowed). Denied writes
 * fail with EROFS ("Read-only file system").
 *
 * Design, rationale, spike results and the enhancement backlog: SANDBOX.md.
 * Keep SANDBOX.md in sync when changing the profile or the bwrap args.
 */

import { accessSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { X_OK } from "node:constants";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * A place commands may write to. `path` may start with `~` (the HOME
 * parameter) or `$TMPDIR` (the TMPDIR parameter); both are resolved by the
 * profile, so the profile text does not depend on the user.
 */
export interface WritePath {
  kind: "literal" | "subpath" | "regex";
  path: string;
  why: string;
}

export const SAFE_WRITE_PATHS: readonly WritePath[] = [
  {
    kind: "literal",
    path: "/dev/null",
    why: "discarding output; git opens it read-write",
  },
  { kind: "literal", path: "/dev/zero", why: "commonly opened read-write" },
  { kind: "literal", path: "/dev/stdout", why: "explicit writes to stdout" },
  { kind: "literal", path: "/dev/stderr", why: "explicit writes to stderr" },
  { kind: "literal", path: "/dev/tty", why: "terminal prompts" },
  {
    kind: "literal",
    path: "/dev/dtracehelper",
    why: "opened by dyld/node at startup",
  },
  { kind: "literal", path: "/dev/ptmx", why: "pseudo-terminal allocation" },
  {
    kind: "regex",
    path: "^/dev/fd/[0-9]+$",
    why: "process substitution and fd redirects",
  },
  { kind: "regex", path: "^/dev/ttys[0-9]+$", why: "terminal devices" },
  { kind: "subpath", path: "/private/tmp", why: "/tmp scratch files" },
  {
    kind: "subpath",
    path: "/private/var/folders",
    why: "per-user temp and cache dirs (default $TMPDIR, clang/xcrun caches)",
  },
  {
    kind: "subpath",
    path: "$TMPDIR",
    why: "$TMPDIR when it is not under /var/folders",
  },
  {
    kind: "subpath",
    path: "~/.cache",
    why: "tool caches (nix, uv, pre-commit, ...)",
  },
  {
    kind: "subpath",
    path: "~/Library/Caches",
    why: "macOS tool caches (go build cache, pip, ...)",
  },
  {
    kind: "subpath",
    path: "~/.npm",
    why: "npm writes _logs and _cacache even for `npm view`",
  },
];

/** Unix sockets commands may not connect to (they would run things outside the sandbox). */
export const BLOCKED_SOCKETS: readonly { regex: string; why: string }[] = [
  {
    regex: "^/private/tmp/tmux-",
    why: "tmux server: send-keys / run-shell would run commands unsandboxed",
  },
];

/** Escape a string for an SBPL string literal. */
const sbplString = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function pathExpression(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return `(string-append (param "HOME") ${sbplString(path.slice(1))})`;
  }
  if (path === "$TMPDIR" || path.startsWith("$TMPDIR/")) {
    const rest = path.slice("$TMPDIR".length);
    return rest
      ? `(string-append (param "TMPDIR") ${sbplString(rest)})`
      : `(param "TMPDIR")`;
  }
  return sbplString(path);
}

function writeRule(entry: WritePath): string {
  if (entry.kind === "regex") return `(regex #${sbplString(entry.path)})`;
  return `(${entry.kind} ${pathExpression(entry.path)})`;
}

/**
 * Profile text. `extraWritable` are absolute, canonical paths (subpaths) added
 * to SAFE_WRITE_PATHS.
 */
export function buildProfile(extraWritable: readonly string[] = []): string {
  const writable = [
    ...SAFE_WRITE_PATHS,
    ...extraWritable.map((path): WritePath => ({
      kind: "subpath",
      path,
      why: "extra",
    })),
  ];
  return [
    "(version 1)",
    "(allow default)",
    ";; Read-only filesystem, except scratch, temp and cache folders.",
    "(deny file-write*)",
    "(allow file-write*",
    ...writable.map((entry) => `  ${writeRule(entry)}`),
    ")",
    ";; Sockets of servers that would run commands outside the sandbox.",
    ...BLOCKED_SOCKETS.map(
      ({ regex }) =>
        `(deny network-outbound (remote unix-socket (path-regex #${sbplString(regex)})))`,
    ),
    "",
  ].join("\n");
}

/** Single-quote a string for POSIX shells. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SandboxParams {
  /** Canonical home directory (symlinks resolved; the kernel matches real paths). */
  home: string;
  /** Canonical temp directory, without a trailing slash. */
  tmpdir: string;
}

function canonical(path: string): string {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // keep as given
  }
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

export function sandboxParams(
  env: NodeJS.ProcessEnv = process.env,
): SandboxParams {
  return {
    home: canonical(env.HOME || "/var/empty"),
    tmpdir: canonical(env.TMPDIR || "/tmp"),
  };
}

export type SandboxBackend = "seatbelt" | "bwrap";

/** Resolve `name` on PATH to an absolute path (executable), or undefined. */
export function findOnPath(
  name: string,
  pathEnv: string = process.env.PATH ?? "",
): string | undefined {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Cache: probing spawns a process; do it once per resolved bwrap path. */
let bwrapProbe: { path: string; ok: boolean } | undefined;

/**
 * bwrap can actually sandbox here: it exists and can create user+mount
 * namespaces. On Ubuntu with kernel.apparmor_restrict_unprivileged_userns=1
 * only AppArmor-covered binaries (the apt package's /usr/bin/bwrap) pass.
 */
function probeBwrap(env: NodeJS.ProcessEnv): string | undefined {
  const path = findOnPath("bwrap", env.PATH ?? "");
  if (!path) return undefined;
  if (bwrapProbe?.path === path) return bwrapProbe.ok ? path : undefined;
  const result = spawnSync(path, ["--ro-bind", "/", "/", "--", "true"], {
    stdio: "ignore",
    timeout: 5000,
  });
  const ok = result.status === 0;
  bwrapProbe = { path, ok };
  return ok ? path : undefined;
}

/** The backend this machine can run, or undefined (bash is refused in plan mode). */
export function sandboxBackend(
  env: NodeJS.ProcessEnv = process.env,
): SandboxBackend | undefined {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC))
    return "seatbelt";
  if (process.platform === "linux" && probeBwrap(env)) return "bwrap";
  return undefined;
}

export function sandboxAvailable(): boolean {
  return sandboxBackend() !== undefined;
}

/**
 * Writable locations for the bwrap backend: /tmp, $TMPDIR and tool caches,
 * resolved against `params`. Only existing paths are returned (bwrap fails
 * when a --bind source is missing), deduped by canonical path.
 */
export function bwrapWritablePaths(params: SandboxParams): string[] {
  const candidates = [
    "/tmp",
    params.tmpdir,
    `${params.home}/.cache`,
    `${params.home}/.npm`,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const path = canonical(raw);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * tmux server sockets to shadow with /dev/null (a reachable tmux server would
 * run commands outside the sandbox). Best effort: sockets created later, a
 * custom `tmux -L` name in another directory, or screen are not covered;
 * bash-policy denies tmux regardless.
 */
export function bwrapBlockedSockets(
  env: NodeJS.ProcessEnv,
  uid: number | undefined = process.getuid?.(),
): string[] {
  if (uid === undefined) return [];
  const dir = join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`);
  try {
    return readdirSync(dir).map((entry) => join(dir, entry));
  } catch {
    return []; // no tmux server running (or unreadable dir)
  }
}

/** bwrap argv (after `bwrap`): read-only host / plus the writable re-binds. */
export function buildBwrapArgs(
  command: string,
  options: { shell: string; params: SandboxParams; env?: NodeJS.ProcessEnv },
): string[] {
  const env = options.env ?? process.env;
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const path of bwrapWritablePaths(options.params))
    args.push("--bind", path, path);
  for (const socket of bwrapBlockedSockets(env))
    args.push("--ro-bind", "/dev/null", socket);
  args.push("--die-with-parent", "--", options.shell, "-c", command);
  return args;
}

/** The command line that runs `command` with `shell -c` inside the sandbox. */
export function wrapCommand(
  command: string,
  options: {
    shell: string;
    params: SandboxParams;
    backend: SandboxBackend;
    extraWritable?: readonly string[]; // seatbelt only (buildProfile passthrough)
    env?: NodeJS.ProcessEnv; // bwrap: PATH/TMUX_TMPDIR lookup
  },
): string {
  const { shell, params, backend } = options;
  if (backend === "seatbelt") {
    return [
      "exec",
      SANDBOX_EXEC,
      "-p",
      shellQuote(buildProfile(options.extraWritable ?? [])),
      "-D",
      shellQuote(`HOME=${params.home}`),
      "-D",
      shellQuote(`TMPDIR=${params.tmpdir}`),
      shellQuote(shell),
      "-c",
      shellQuote(command),
    ].join(" ");
  }
  const bwrap =
    findOnPath("bwrap", (options.env ?? process.env).PATH ?? "") ?? "bwrap";
  return [
    "exec",
    ...[bwrap, ...buildBwrapArgs(command, { shell, params, env: options.env })].map(
      shellQuote,
    ),
  ].join(" ");
}

/**
 * The sandbox itself failed, not the command. Seatbelt: the profile did not
 * load (exit 65) or the shell could not be started (exit 71), messages start
 * with "sandbox-exec:". bwrap: setup errors exit 1 and start with "bwrap:"
 * (a command that prints "bwrap:" first and exits 1 is a documented false
 * positive — fail closed).
 */
export function isProfileError(
  exitCode: number | undefined,
  output: string,
  backend?: SandboxBackend,
): boolean {
  const text = output.trimStart();
  const seatbelt =
    (exitCode === 65 || exitCode === 71) && text.startsWith("sandbox-exec:");
  const bwrapErr = exitCode === 1 && text.startsWith("bwrap:");
  if (backend === "seatbelt") return seatbelt;
  if (backend === "bwrap") return bwrapErr;
  return seatbelt || bwrapErr;
}

/**
 * The output shows a write (or socket connect) the sandbox refused: the error
 * as tools report it ("cmd: …: Operation not permitted", "PermissionError:
 * [Errno 1] Operation not permitted: '…'", "error connecting to … (Operation
 * not permitted)"), not the phrase merely appearing in quoted text such as a
 * prompt, a doc or a diff. Seatbelt denials are EPERM ("Operation not
 * permitted"); bwrap's read-only bind mounts fail with EROFS ("Read-only
 * file system") — both count.
 */
export function isSandboxDenial(output: string): boolean {
  const text = output.replace(/\r/g, "");
  // EPERM from Seatbelt, EROFS from read-only bind mounts, as tools report them.
  const err = "(?:Operation not permitted|Read-only file system)";
  // "cmd: …: <err>" (end of line, or Python's "…: 'path'").
  if (new RegExp(`[:([\\]]\\s${err}(\\s*:\\s*'[^']*')?$`, "m").test(text))
    return true;
  // "error connecting to … (<err>)"
  return new RegExp(`\\(${err}\\)`).test(text);
}
