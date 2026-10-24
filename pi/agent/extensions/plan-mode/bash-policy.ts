/**
 * Side-effect policy for bash in plan mode.
 *
 * Plan-mode bash always runs inside the OS sandbox (sandbox.ts), which makes
 * the filesystem read-only apart from scratch, temp and cache folders. This
 * policy covers what the sandbox cannot see: side effects outside the
 * machine's filesystem (pushes, API writes, deploys, remote shells) and
 * changes made by services on the command's behalf (nix-daemon, launchd,
 * cfprefsd, docker, other processes).
 *
 * classifyBashCommand() splits a command line into simple commands (on ; && ||
 * | & newlines and subshell parens), pulls out command/process substitutions,
 * heredoc substitutions, `sh -c` / `eval` scripts and wrapped commands (env,
 * xargs, timeout, find -exec, ...) for recursive checks, and combines:
 *
 *   allow  nothing on the side-effect table (the default, including unknown
 *          programs and local file writes, which the sandbox handles)
 *   deny   never allowed in plan mode (reboot, ...)
 *   ask    a listed side effect; the caller asks the user. Each item's `key`
 *          is what "allow for this session" remembers. Approved commands
 *          still run sandboxed.
 *
 * Best effort: scripts and programs can still cause network side effects the
 * table does not list. See SANDBOX.md.
 */

export interface AskItem {
  /** What "allow for this session" remembers, e.g. `terraform` or `git worktree`. */
  key: string;
  reason: string;
}

export type BashVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; items: AskItem[] };

interface Redirect {
  op: string;
  target: string;
}

interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
}

interface ParsedLine {
  commands: SimpleCommand[];
  /** Bodies of $(...), `...`, <(...) and >(...), checked recursively. */
  substitutions: string[];
  /** Set when parsing failed or hit a construct we refuse to reason about. */
  problem?: string;
}

const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Index of the `)` matching an already-consumed `(`, honouring quotes and escapes. */
function findClosingParen(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      if (i >= s.length) return -1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing backtick for one opened at `from - 1`. */
function findClosingBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return -1;
}

/** Index just past the `))` closing an arithmetic expansion opened with `$((`. */
function skipArithmetic(s: string, from: number): number {
  let depth = 2;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function parseCommandLine(s: string): ParsedLine {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean; quoted: boolean }[] =
    [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let cur: string | null = null;
  let curQuoted = false;
  let pendingRedirect: string | null = null;
  let problem: string | undefined;

  const pushWord = (word: string, quoted: boolean) => {
    if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, target: word });
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        heredocs.push({
          delimiter: word,
          stripTabs: pendingRedirect === "<<-",
          quoted,
        });
      }
      pendingRedirect = null;
    } else {
      words.push(word);
    }
  };
  const endWord = () => {
    if (cur !== null) pushWord(cur, curQuoted);
    cur = null;
    curQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect !== null) {
      problem ??= `redirect "${pendingRedirect}" without a target`;
      pendingRedirect = null;
    }
    if (words.length > 0 || redirects.length > 0)
      commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  const append = (text: string) => {
    cur = (cur ?? "") + text;
  };

  /** Consumes `$(...)`, `$((...))` or a backtick expansion at i; returns [text, next] or undefined. */
  const readExpansion = (i: number): [string, number] | undefined => {
    if (s.startsWith("$((", i)) {
      const end = skipArithmetic(s, i + 3);
      return end < 0 ? undefined : [s.slice(i, end), end];
    }
    if (s.startsWith("$(", i)) {
      const end = findClosingParen(s, i + 2);
      if (end < 0) return undefined;
      substitutions.push(s.slice(i + 2, end));
      return ["$(…)", end + 1];
    }
    const end = findClosingBacktick(s, i + 1);
    if (end < 0) return undefined;
    substitutions.push(s.slice(i + 1, end));
    return ["`…`", end + 1];
  };

  /** Substitutions in an unquoted heredoc line (they run when the heredoc is expanded). */
  const collectSubstitutions = (line: string) => {
    for (let k = 0; k < line.length; k++) {
      if (line[k] === "\\") k++;
      else if (
        line[k] === "`" ||
        (line[k] === "$" && line[k + 1] === "(" && line[k + 2] !== "(")
      ) {
        const open = line[k] === "`" ? k + 1 : k + 2;
        const end =
          line[k] === "`"
            ? findClosingBacktick(line, open)
            : findClosingParen(line, open);
        if (end < 0) {
          problem ??= "multi-line command substitution inside a heredoc";
          return;
        }
        substitutions.push(line.slice(open, end));
        k = end;
      }
    }
  };

  /** Skips heredoc bodies that start right after a newline at position i. */
  const skipHeredocBodies = (i: number): number => {
    while (heredocs.length > 0) {
      const doc = heredocs.shift()!;
      while (i < s.length) {
        const nl = s.indexOf("\n", i);
        const lineEnd = nl < 0 ? s.length : nl;
        const raw = s.slice(i, lineEnd);
        i = nl < 0 ? s.length : nl + 1;
        const line = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (line === doc.delimiter) break;
        if (!doc.quoted) collectSubstitutions(line);
      }
    }
    return i;
  };

  let i = 0;
  while (i < s.length && problem === undefined) {
    const c = s[i];

    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\\") {
      if (s[i + 1] !== "\n") {
        append(s[i + 1] ?? "");
        curQuoted = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) problem = "unterminated single quote";
      else {
        append(s.slice(i + 1, end));
        curQuoted = true;
        i = end + 1;
      }
    } else if (c === '"') {
      let k = i + 1;
      let buf = "";
      let failed = false;
      while (k < s.length && s[k] !== '"') {
        if (s[k] === "\\" && k + 1 < s.length) {
          buf += s[k + 1];
          k += 2;
        } else if ((s[k] === "$" && s[k + 1] === "(") || s[k] === "`") {
          const expansion = readExpansion(k);
          if (!expansion) {
            failed = true;
            break;
          }
          buf += expansion[0];
          k = expansion[1];
        } else {
          buf += s[k];
          k++;
        }
      }
      if (failed || k >= s.length)
        problem = "unterminated double quote or expansion";
      else {
        append(buf);
        curQuoted = true;
        i = k + 1;
      }
    } else if ((c === "$" && s[i + 1] === "(") || c === "`") {
      const expansion = readExpansion(i);
      if (!expansion) problem = "unterminated command substitution";
      else {
        append(expansion[0]);
        i = expansion[1];
      }
    } else if (c === "#" && cur === null) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "\n") {
      endCommand();
      i = skipHeredocBodies(i + 1);
    } else if (c === ";") {
      endCommand();
      i += s[i + 1] === ";" ? 2 : 1;
    } else if (c === "&") {
      if (s[i + 1] === "&") {
        endCommand();
        i += 2;
      } else if (s[i + 1] === ">") {
        endWord();
        pendingRedirect = s[i + 2] === ">" ? "&>>" : "&>";
        i += pendingRedirect.length;
      } else {
        endCommand();
        i++;
      }
    } else if (c === "|") {
      endCommand();
      i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1;
    } else if (c === "(" || c === ")") {
      endCommand();
      i++;
    } else if (c === "<" || c === ">") {
      if (s[i + 1] === "(") {
        const end = findClosingParen(s, i + 2);
        if (end < 0) problem = "unterminated process substitution";
        else {
          substitutions.push(s.slice(i + 2, end));
          append(`${c}(…)`);
          i = end + 1;
        }
        continue;
      }
      // A word made only of digits right before the operator is an fd number.
      if (cur !== null && !curQuoted && /^\d+$/.test(cur)) cur = null;
      else endWord();
      let op: string;
      if (c === ">") {
        op =
          s[i + 1] === ">"
            ? ">>"
            : s[i + 1] === "&"
              ? ">&"
              : s[i + 1] === "|"
                ? ">|"
                : ">";
      } else if (s.startsWith("<<<", i)) op = "<<<";
      else if (s.startsWith("<<-", i)) op = "<<-";
      else
        op =
          s[i + 1] === "<"
            ? "<<"
            : s[i + 1] === "&"
              ? "<&"
              : s[i + 1] === ">"
                ? "<>"
                : "<";
      pendingRedirect = op;
      i += op.length;
    } else {
      append(c);
      i++;
    }
  }
  if (problem === undefined) endCommand();
  return { commands, substitutions, problem };
}

/** Word list from a space-separated string. */
const w = (list: string): string[] => list.split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// Verdict helpers
// ---------------------------------------------------------------------------

type Rule = (args: string[], program: string) => BashVerdict;

const ALLOW: BashVerdict = { kind: "allow" };
const deny = (reason: string): BashVerdict => ({ kind: "deny", reason });
const ask = (key: string, reason: string): BashVerdict => ({
  kind: "ask",
  items: [{ key, reason }],
});

function combine(verdicts: BashVerdict[]): BashVerdict {
  const denied = verdicts.find((v) => v.kind === "deny");
  if (denied) return denied;
  const seen = new Set<string>();
  const items = verdicts
    .flatMap((v) => (v.kind === "ask" ? v.items : []))
    .filter((item) => !seen.has(item.key) && seen.add(item.key));
  return items.length === 0 ? ALLOW : { kind: "ask", items };
}

/** Short flags in a cluster (`-rf`) or long flags by name (`--force`, `--output=x`). */
function hasFlag(
  args: string[],
  shorts: string,
  longs: string[] = [],
): boolean {
  return args.some((arg) => {
    if (arg.startsWith("--")) return longs.includes(arg.split("=", 1)[0]);
    if (/^-[A-Za-z0-9]+$/.test(arg))
      return [...arg.slice(1)].some((ch) => shorts.includes(ch));
    return false;
  });
}

const positionals = (args: string[]) => args.filter((a) => !a.startsWith("-"));
const first = (args: string[]) => args[0] ?? "";

/** Value of `-X VALUE`, `-XVALUE` or `--long VALUE` / `--long=VALUE`. */
function flagValue(
  args: string[],
  short: string,
  long: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || a === long) return args[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (a.startsWith(short) && a.length > short.length && !a.startsWith("--"))
      return a.slice(short.length);
  }
  return undefined;
}

/** First non-flag word (skipping values of `withValue` flags) and what follows it. */
function subcommand(
  args: string[],
  withValue: string[] = [],
): { sub: string | undefined; rest: string[] } {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (withValue.includes(args[index])) index++;
    index++;
  }
  return { sub: args[index], rest: args.slice(index + 1) };
}

const isReadMethod = (method: string | undefined) =>
  method === undefined ||
  ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/**
 * Tools whose read subcommands are known: those are allowed, a bare call or
 * flags-only call (--version, --help) is allowed, anything else asks.
 */
function readSubcommands(options: {
  read: string[];
  reason: string;
  check?: Record<string, (rest: string[], program: string) => BashVerdict>;
  withValue?: string[];
}): Rule {
  return (args, program) => {
    const { sub, rest } = subcommand(args, options.withValue);
    if (sub === undefined) return ALLOW;
    const check = options.check?.[sub];
    if (check) return check(rest, program);
    if (options.read.includes(sub)) return ALLOW;
    return ask(`${program} ${sub}`, `"${program} ${sub}" ${options.reason}`);
  };
}

/** Tools whose writing subcommands are known: those ask, everything else is allowed. */
function writeSubcommands(options: {
  write: string[];
  reason: string;
  check?: Record<string, (rest: string[], program: string) => BashVerdict>;
  withValue?: string[];
}): Rule {
  return (args, program) => {
    const { sub, rest } = subcommand(args, options.withValue);
    if (sub === undefined) return ALLOW;
    const check = options.check?.[sub];
    if (check) return check(rest, program);
    if (options.write.includes(sub))
      return ask(`${program} ${sub}`, `"${program} ${sub}" ${options.reason}`);
    return ALLOW;
  };
}

/** Ask for the whole program unless it is only asked for its version or help. */
const askUnlessInfo =
  (reason: string): Rule =>
  (args, program) =>
    args.length > 0 &&
    args.every((a) =>
      ["--version", "-V", "-v", "version", "--help", "-h", "help"].includes(a),
    )
      ? ALLOW
      : ask(program, `"${program}" ${reason}`);

// ---------------------------------------------------------------------------
// git / gh
// ---------------------------------------------------------------------------

function gitRule(args: string[]): BashVerdict {
  const { sub, rest } = subcommand(
    args,
    w("-C -c --git-dir --work-tree --namespace --config-env"),
  );
  if (sub === "push")
    return ask("git push", "git push changes a remote repository");
  if (sub === "send-email")
    return ask("git send-email", "git send-email sends email");
  if (sub === "lfs" && first(rest) === "push")
    return ask("git lfs push", "git lfs push uploads to a remote");
  if (sub === "svn" && first(rest) === "dcommit")
    return ask(
      "git svn dcommit",
      "git svn dcommit changes a remote repository",
    );
  return ALLOW;
}

/** gh groups that only change local files (the sandbox handles those). */
const GH_LOCAL_GROUPS = new Set([
  "config",
  "alias",
  "extension",
  "completion",
  "help",
]);
const GH_READ_ACTIONS = new Set(
  w(
    "view list ls diff checks status watch search download checkout clone logs verify verify-asset trusted-root",
  ),
);

function ghApiRule(rest: string[]): BashVerdict {
  const method = flagValue(rest, "-X", "--method");
  if (!isReadMethod(method))
    return ask(
      "gh api write",
      `gh api ${method?.toUpperCase()} sends a write request`,
    );
  const graphql = positionals(rest)[0] === "graphql";
  if (graphql) {
    return rest.some((a) => /\bmutation\b/.test(a))
      ? ask("gh api write", "gh api graphql mutation changes GitHub")
      : ALLOW;
  }
  // Fields and --input turn the request into a POST unless -X GET is given.
  if (
    method === undefined &&
    hasFlag(rest, "fF", ["--field", "--raw-field", "--input"])
  )
    return ask("gh api write", "gh api with fields sends a POST request");
  return ALLOW;
}

function ghRule(args: string[]): BashVerdict {
  const { sub: group, rest } = subcommand(args, ["-R", "--repo", "--hostname"]);
  if (
    group === undefined ||
    ["status", "search", "version", "help"].includes(group)
  )
    return ALLOW;
  if (group === "api") return ghApiRule(rest);
  if (group === "browse")
    return ask("gh browse", "gh browse opens a browser outside the sandbox");
  if (group === "auth")
    return ["status", "token"].includes(first(rest))
      ? ALLOW
      : ask(`gh auth ${first(rest)}`.trim(), "gh auth changes credentials");
  if (GH_LOCAL_GROUPS.has(group)) return ALLOW;
  const action = subcommand(rest, ["-R", "--repo"]).sub;
  if (action === undefined || GH_READ_ACTIONS.has(action)) return ALLOW;
  return ask(
    `gh ${group} ${action}`,
    `"gh ${group} ${action}" may change GitHub`,
  );
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

function curlRule(args: string[]): BashVerdict {
  const method = flagValue(args, "-X", "--request");
  if (!isReadMethod(method))
    return ask(
      "curl write",
      `curl ${method?.toUpperCase()} sends a write request`,
    );
  if (hasFlag(args, "K", ["--config"]))
    return ask("curl write", "curl --config may send data");
  if (hasFlag(args, "T", ["--upload-file"]))
    return ask("curl write", "curl --upload-file uploads data");
  const sendsData = hasFlag(
    args,
    "dF",
    w(
      "--data --data-raw --data-binary --data-urlencode --data-ascii --json --form --form-string",
    ),
  );
  // -G / --get sends --data as a query string of a GET request.
  if (sendsData && !(method !== undefined || hasFlag(args, "G", ["--get"])))
    return ask("curl write", "curl with data sends a POST request");
  return ALLOW;
}

function wgetRule(args: string[]): BashVerdict {
  const method = flagValue(args, "--method", "--method");
  if (!isReadMethod(method))
    return ask(
      "wget write",
      `wget ${method?.toUpperCase()} sends a write request`,
    );
  return hasFlag(args, "", [
    "--post-data",
    "--post-file",
    "--body-data",
    "--body-file",
  ])
    ? ask("wget write", "wget sends data")
    : ALLOW;
}

/** HTTPie / xh: `http [flags] [METHOD] URL [items]`; data items imply POST. */
function httpieRule(args: string[], program: string): BashVerdict {
  if (hasFlag(args, "", ["--offline"])) return ALLOW;
  const words = positionals(args);
  const method = /^[A-Z]+$/.test(first(words)) ? words.shift() : undefined;
  if (!isReadMethod(method))
    return ask(
      `${program} write`,
      `${program} ${method} sends a write request`,
    );
  const items = words.slice(1);
  const dataItem = /^[^=:@]+(:=|=(?!=)|@)/;
  if (
    method === undefined &&
    (items.some((item) => dataItem.test(item)) ||
      hasFlag(args, "f", ["--form", "--raw"]))
  )
    return ask(
      `${program} write`,
      `${program} with data items sends a POST request`,
    );
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Cloud and cluster tools
// ---------------------------------------------------------------------------

const AWS_READ_PREFIXES = w(
  "describe list get show head search lookup filter scan query validate tail wait batch-get help",
);

function awsRule(args: string[]): BashVerdict {
  const withValue = [
    "--profile",
    "--region",
    "--output",
    "--endpoint-url",
    "--query",
    "--color",
    "--cli-read-timeout",
    "--cli-connect-timeout",
  ];
  const { sub: service, rest } = subcommand(args, withValue);
  if (service === undefined || service === "help") return ALLOW;
  if (service === "configure") return ALLOW; // local ~/.aws files (sandboxed)
  const operation = subcommand(rest, withValue).sub;
  if (operation === undefined) return ALLOW;
  if (service === "s3") {
    return ["ls", "presign"].includes(operation)
      ? ALLOW
      : ask(`aws s3 ${operation}`, `"aws s3 ${operation}" may change S3`);
  }
  if (
    service === "sts" ||
    service === "sso" ||
    (service === "ecr" && operation === "get-login-password")
  )
    return ALLOW;
  return AWS_READ_PREFIXES.some(
    (prefix) => operation === prefix || operation.startsWith(`${prefix}-`),
  )
    ? ALLOW
    : ask(
        `aws ${service} ${operation}`,
        `"aws ${service} ${operation}" may change AWS resources`,
      );
}

/** Verbs of gcloud / az command groups that change resources. */
const CLOUD_WRITE_VERBS = new Set(
  w(
    "create delete update set unset patch deploy apply start stop restart reset resize rollback enable disable import run execute invoke call submit cancel ssh scp purge assign grant revoke attach detach move promote restore upgrade scale",
  ),
);

const cloudRule: Rule = (args, program) => {
  const verb = positionals(args).find(
    (word) =>
      CLOUD_WRITE_VERBS.has(word) ||
      /^(add|remove|set|create|delete|update)-/.test(word),
  );
  return verb
    ? ask(
        `${program} ${verb}`,
        `"${program} … ${verb}" may change cloud resources`,
      )
    : ALLOW;
};

const KUBECTL_READ = w(
  "get describe logs explain api-resources api-versions version cluster-info top diff events wait completion plugin kustomize",
);

const kubectlRule = readSubcommands({
  read: KUBECTL_READ,
  reason: "may change the cluster",
  withValue: [
    "-n",
    "--namespace",
    "--context",
    "--cluster",
    "--kubeconfig",
    "-l",
    "--selector",
    "--user",
    "-s",
    "--server",
  ],
  check: {
    config: () => ALLOW, // kubeconfig is a local file (sandboxed)
    rollout: (rest) =>
      ["status", "history"].includes(first(rest))
        ? ALLOW
        : ask(
            `kubectl rollout ${first(rest)}`.trim(),
            "kubectl rollout changes the cluster",
          ),
    auth: (rest) =>
      ["can-i", "whoami"].includes(first(rest))
        ? ALLOW
        : ask(
            `kubectl auth ${first(rest)}`.trim(),
            "kubectl auth may change the cluster",
          ),
  },
});

const helmRule = writeSubcommands({
  write: [
    "install",
    "upgrade",
    "uninstall",
    "delete",
    "del",
    "rollback",
    "test",
    "push",
  ],
  reason: "changes a cluster or registry",
  withValue: ["-n", "--namespace", "--kube-context", "--kubeconfig"],
  check: {
    registry: (rest) =>
      ask(
        `helm registry ${first(rest)}`.trim(),
        "helm registry changes credentials",
      ),
  },
});

const terraformRule = writeSubcommands({
  write: [
    "apply",
    "destroy",
    "import",
    "refresh",
    "taint",
    "untaint",
    "force-unlock",
    "login",
    "logout",
  ],
  reason: "changes infrastructure or remote state",
  check: {
    state: (rest, program) =>
      ["list", "show", "pull"].includes(first(rest))
        ? ALLOW
        : ask(
            `${program} state ${first(rest)}`.trim(),
            `"${program} state" changes remote state`,
          ),
    workspace: (rest, program) =>
      ["new", "delete"].includes(first(rest))
        ? ask(
            `${program} workspace ${first(rest)}`,
            `"${program} workspace ${first(rest)}" changes remote state`,
          )
        : ALLOW,
  },
});

const pulumiRule = writeSubcommands({
  write: [
    "up",
    "update",
    "destroy",
    "refresh",
    "import",
    "cancel",
    "new",
    "watch",
  ],
  reason: "changes infrastructure or stacks",
  check: {
    stack: (rest) =>
      ["rm", "init", "rename", "change-secrets-provider", "import"].includes(
        first(rest),
      ) ||
      (first(rest) === "tag" && rest[1] !== "ls")
        ? ask(`pulumi stack ${first(rest)}`, "pulumi stack change")
        : ALLOW,
    config: (rest) =>
      ["set", "rm", "set-all", "rm-all", "refresh", "cp"].includes(first(rest))
        ? ask(`pulumi config ${first(rest)}`, "pulumi config change")
        : ALLOW,
  },
});

// ---------------------------------------------------------------------------
// Nix
// ---------------------------------------------------------------------------

const nixRule: Rule = (args) => {
  const { sub, rest } = subcommand(args, [
    "--option",
    "--extra-experimental-features",
    "--experimental-features",
  ]);
  switch (sub) {
    case "build":
      return hasFlag(rest, "", ["--dry-run"])
        ? ALLOW
        : ask(
            "nix build",
            "nix build builds into the store through nix-daemon",
          );
    case "profile":
      return ["list", "history", "diff-closures"].includes(first(rest))
        ? ALLOW
        : ask(
            `nix profile ${first(rest)}`.trim(),
            "nix profile changes installed packages",
          );
    case "store":
      return [
        "gc",
        "delete",
        "repair",
        "optimise",
        "add",
        "add-path",
        "add-file",
        "copy-sigs",
        "sign",
      ].includes(first(rest))
        ? ask(
            `nix store ${first(rest)}`,
            `"nix store ${first(rest)}" changes the store through nix-daemon`,
          )
        : ALLOW;
    case "copy":
      return ask("nix copy", "nix copy writes to another store");
    case "upgrade-nix":
      return ask(
        "nix upgrade-nix",
        "nix upgrade-nix changes the Nix installation",
      );
    default:
      return ALLOW;
  }
};

const nixStoreRule: Rule = (args) =>
  hasFlag(args, "r", [
    "--delete",
    "--gc",
    "--optimise",
    "--repair-path",
    "--realise",
    "--add",
    "--add-fixed",
    "--import",
    "--load-db",
  ])
    ? ask("nix-store", "nix-store changes the store through nix-daemon")
    : ALLOW;

const nixEnvRule: Rule = (args) =>
  hasFlag(
    args,
    "ieu",
    w(
      "--install --uninstall --upgrade --set --rollback --switch-generation --delete-generations --switch-profile",
    ),
  )
    ? ask("nix-env", "nix-env changes installed packages")
    : ALLOW;

const homeManagerRule: Rule = (args) => {
  const { sub } = subcommand(args, ["-f", "--file", "-A", "--flake", "-I"]);
  return sub === undefined ||
    ["generations", "packages", "news", "help", "option", "edit"].includes(sub)
    ? ALLOW
    : ask(
        `home-manager ${sub}`,
        `"home-manager ${sub}" builds or activates a configuration`,
      );
};

// ---------------------------------------------------------------------------
// Local services, processes and apps
// ---------------------------------------------------------------------------

const BREW_READ = w(
  "list ls info search deps uses outdated config doctor desc home leaves commands --prefix --cellar --repository --cache --env cat log formulae casks shellenv",
);

const DOCKER_READ = w(
  "ps images inspect logs version info top stats history port search events diff",
);
const DOCKER_GROUP_READ = new Set([
  "ls",
  "list",
  "ps",
  "inspect",
  "logs",
  "config",
  "df",
  "info",
  "show",
  "top",
  "images",
  "port",
  "version",
  "events",
  "history",
]);
const DOCKER_GROUPS = [
  "container",
  "image",
  "volume",
  "network",
  "context",
  "system",
  "buildx",
  "manifest",
  "compose",
  "node",
  "service",
  "stack",
  "plugin",
  "secret",
  "machine",
];

const dockerRule = readSubcommands({
  read: DOCKER_READ,
  reason: "changes containers, images or registries through the daemon",
  withValue: ["--context", "-H", "--host", "-c", "--connection", "--config"],
  check: Object.fromEntries(
    DOCKER_GROUPS.map((group) => [
      group,
      (rest: string[], program: string) => {
        const action = subcommand(rest, [
          "-f",
          "--file",
          "-p",
          "--project-name",
        ]).sub;
        return action === undefined || DOCKER_GROUP_READ.has(action)
          ? ALLOW
          : ask(
              `${program} ${group} ${action}`,
              `"${program} ${group} ${action}" changes state through the daemon`,
            );
      },
    ]),
  ),
});

const LAUNCHCTL_READ = w(
  "list print print-cache print-disabled blame dumpstate procinfo hostinfo resolveport examine managerpid manageruid managername version help error getenv",
);

const SYSTEMCTL_READ = w(
  "status list-units list-unit-files list-timers list-sockets list-dependencies show is-active is-enabled is-failed cat help",
);

function securityRule(args: string[]): BashVerdict {
  const { sub, rest } = subcommand(args);
  if (sub === undefined) return ALLOW;
  const changes =
    /^(add|delete|set|remove|create|unlock|lock|import|install)(-|$)/.test(
      sub,
    ) ||
    [
      "add-trusted-cert",
      "remove-trusted-cert",
      "trust-settings-import",
    ].includes(sub) ||
    (["list-keychains", "default-keychain", "login-keychain"].includes(sub) &&
      hasFlag(rest, "sd", ["--setting"])) ||
    (sub === "authorizationdb" && first(rest) === "write");
  return changes
    ? ask(
        `security ${sub}`,
        `"security ${sub}" changes the keychain or trust settings`,
      )
    : ALLOW;
}

const EDITOR_IPC = [
  "code",
  "codium",
  "cursor",
  "subl",
  "zed",
  "idea",
  "emacsclient",
  "mate",
];
const INTERACTIVE_EDITORS = [
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "pico",
  "micro",
  "hx",
  "helix",
  "kak",
];

function editorRule(args: string[], program: string): BashVerdict {
  if (args.some((a) => a === "--server" || a.startsWith("--remote")))
    return ask(
      `${program} --remote`,
      `"${program} --remote" talks to a running editor outside the sandbox`,
    );
  const scripted = hasFlag(args, "esv", [
    "--headless",
    "--batch",
    "--version",
    "--help",
    "--script",
  ]);
  return scripted
    ? ALLOW
    : deny(`"${program}" is interactive and would wait for input`);
}

// ---------------------------------------------------------------------------
// Program table
// ---------------------------------------------------------------------------

const PUBLISH = new Set([
  "publish",
  "unpublish",
  "deprecate",
  "yank",
  "owner",
  "login",
  "adduser",
  "logout",
  "dist-tag",
  "access",
  "token",
  "push",
  "upload",
]);

const publishRule: Rule = (args, program) => {
  const { sub, rest } = subcommand(args, [
    "-w",
    "--workspace",
    "--filter",
    "-C",
    "--dir",
    "--registry",
  ]);
  if (sub === undefined) return ALLOW;
  if (
    sub === "dist-tag" ||
    sub === "owner" ||
    sub === "access" ||
    sub === "token"
  ) {
    return ["ls", "list", "get"].includes(first(rest)) || rest.length === 0
      ? ALLOW
      : ask(
          `${program} ${sub} ${first(rest)}`,
          `"${program} ${sub}" changes the package registry`,
        );
  }
  return PUBLISH.has(sub)
    ? ask(
        `${program} ${sub}`,
        `"${program} ${sub}" changes the package registry`,
      )
    : ALLOW;
};

const REMOTE_SHELL =
  "connects to another host, where commands run outside the sandbox";

const RULES: Record<string, Rule> = {
  git: gitRule,
  gh: ghRule,
  curl: curlRule,
  wget: wgetRule,
  http: httpieRule,
  https: httpieRule,
  xh: httpieRule,
  xhs: httpieRule,

  ssh: askUnlessInfo(REMOTE_SHELL),
  scp: askUnlessInfo(REMOTE_SHELL),
  sftp: askUnlessInfo(REMOTE_SHELL),
  mosh: askUnlessInfo(REMOTE_SHELL),
  telnet: askUnlessInfo(REMOTE_SHELL),
  nc: askUnlessInfo("opens raw network connections"),
  ncat: askUnlessInfo("opens raw network connections"),
  socat: askUnlessInfo("opens raw network connections"),
  rsync: (args) =>
    positionals(args).some((a) => /^[^/]*:/.test(a) || a.startsWith("rsync://"))
      ? ask("rsync remote", "rsync to or from a remote host")
      : ALLOW,
  "ssh-add": (args) =>
    hasFlag(args, "lL")
      ? ALLOW
      : ask("ssh-add", "ssh-add changes the keys held by ssh-agent"),

  kubectl: kubectlRule,
  helm: helmRule,
  terraform: terraformRule,
  tofu: terraformRule,
  pulumi: pulumiRule,
  aws: awsRule,
  gcloud: cloudRule,
  az: cloudRule,

  nix: nixRule,
  "nix-store": nixStoreRule,
  "nix-env": nixEnvRule,
  "nix-collect-garbage": askUnlessInfo(
    "deletes store paths through nix-daemon",
  ),
  "nix-channel": (args) =>
    hasFlag(args, "", ["--list"])
      ? ALLOW
      : ask("nix-channel", "nix-channel changes channels"),
  "darwin-rebuild": askUnlessInfo(
    "builds or activates the system configuration",
  ),
  "nixos-rebuild": askUnlessInfo(
    "builds or activates the system configuration",
  ),
  "home-manager": homeManagerRule,

  brew: readSubcommands({
    read: BREW_READ,
    reason: "changes installed packages or services",
  }),
  docker: dockerRule,
  podman: dockerRule,
  colima: readSubcommands({
    read: ["status", "list", "ls", "version", "help"],
    reason: "changes the colima VM",
  }),

  npm: publishRule,
  pnpm: publishRule,
  yarn: publishRule,
  bun: publishRule,
  cargo: publishRule,
  uv: publishRule,
  poetry: publishRule,
  gem: publishRule,
  twine: (args) =>
    first(positionals(args)) === "upload"
      ? ask("twine upload", "twine upload publishes a package")
      : ALLOW,

  launchctl: readSubcommands({
    read: LAUNCHCTL_READ,
    reason: "changes launchd services",
  }),
  systemctl: readSubcommands({
    read: SYSTEMCTL_READ,
    reason: "changes systemd services",
  }),
  defaults: (args) =>
    ["write", "delete", "import", "rename"].includes(first(positionals(args)))
      ? ask(
          `defaults ${first(positionals(args))}`,
          "defaults changes preferences through cfprefsd",
        )
      : ALLOW,
  osascript: askUnlessInfo("sends Apple events that control other apps"),
  open: askUnlessInfo("opens files, URLs or apps outside the sandbox"),
  shortcuts: (args) =>
    first(positionals(args)) === "run"
      ? ask(
          "shortcuts run",
          "shortcuts run runs a shortcut outside the sandbox",
        )
      : ALLOW,
  security: securityRule,
  crontab: (args) =>
    hasFlag(args, "l")
      ? ALLOW
      : ask("crontab", "crontab changes scheduled jobs"),
  at: askUnlessInfo("schedules jobs"),

  kill: (args) =>
    hasFlag(args, "lL") ? ALLOW : ask("kill", "kill signals other processes"),
  pkill: askUnlessInfo("signals other processes"),
  killall: askUnlessInfo("signals other processes"),
  sudo: askUnlessInfo("runs a command as another user"),
  su: askUnlessInfo("runs a command as another user"),
  doas: askUnlessInfo("runs a command as another user"),
  reboot: () => deny('"reboot" restarts the machine'),
  shutdown: () => deny('"shutdown" stops the machine'),
  halt: () => deny('"halt" stops the machine'),
  poweroff: () => deny('"poweroff" stops the machine'),

  tmux: (args) =>
    hasFlag(args, "V")
      ? ALLOW
      : deny(
          "the tmux server socket is blocked in plan mode (tmux could run commands outside the sandbox)",
        ),
};
for (const program of EDITOR_IPC) {
  RULES[program] = (args, name) =>
    hasFlag(args, "v", ["--version", "--help", "--list-extensions", "--status"])
      ? ALLOW
      : ask(name, `"${name}" talks to a running editor outside the sandbox`);
}
for (const program of INTERACTIVE_EDITORS) RULES[program] = editorRule;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const CONTROL_KEYWORDS = new Set(w("if then else elif do while until ! {"));
const BLOCK_END_KEYWORDS = new Set(["fi", "done", "esac", "}"]);
const LOOP_HEADERS = new Set(["for", "select", "case", "function"]);

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const isAssignment = (word: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word);

/**
 * For wrapper commands (env, xargs, timeout, ...) return the command they run,
 * "none" when they run nothing, or undefined when `program` is not a wrapper.
 */
function unwrap(
  program: string,
  args: string[],
): string[] | "none" | undefined {
  const rest = (from: number) =>
    from < args.length ? args.slice(from) : "none";
  switch (program) {
    case "command":
    case "builtin":
    case "exec":
    case "nohup":
    case "time":
    case "caffeinate":
    case "stdbuf":
    case "unbuffer":
      return program === "command" && (args[0] === "-v" || args[0] === "-V")
        ? "none"
        : rest(args.findIndex((a) => !a.startsWith("-")) >>> 0);
    case "env": {
      let i = 0;
      while (i < args.length) {
        if (["-u", "--unset", "-C", "--chdir", "-S"].includes(args[i])) i += 2;
        else if (args[i].startsWith("-") || isAssignment(args[i])) i++;
        else break;
      }
      return rest(i);
    }
    case "nice":
      return rest(args[0] === "-n" ? 2 : args[0]?.startsWith("-") ? 1 : 0);
    case "timeout":
    case "gtimeout": {
      let i = 0;
      while (i < args.length && args[i].startsWith("-"))
        i += args[i] === "-s" || args[i] === "-k" ? 2 : 1;
      return rest(i + 1); // skip the duration
    }
    case "watch": {
      let i = 0;
      while (i < args.length && args[i].startsWith("-"))
        i += ["-n", "--interval", "-d"].includes(args[i]) ? 2 : 1;
      return rest(i);
    }
    case "xargs": {
      const withValue = w(
        "-I -L -n -P -s -E -d -a --max-args --max-procs --delimiter --arg-file",
      );
      let i = 0;
      while (i < args.length && args[i].startsWith("-"))
        i += withValue.includes(args[i]) ? 2 : 1;
      return i < args.length ? args.slice(i) : ["echo"];
    }
    default:
      return undefined;
  }
}

/** Commands run by `find -exec … ;` / `fd -x …` (each one is classified). */
function execArguments(program: string, args: string[]): string[][] {
  const commands: string[][] = [];
  const execFlags =
    program === "find"
      ? ["-exec", "-execdir", "-ok", "-okdir"]
      : program === "fd" || program === "fdfind"
        ? ["-x", "--exec", "-X", "--exec-batch"]
        : [];
  if (execFlags.length === 0) return commands;
  for (let i = 0; i < args.length; i++) {
    if (!execFlags.includes(args[i])) continue;
    const end = args.findIndex(
      (a, j) => j > i && (a === ";" || a === "+" || a === "\\;"),
    );
    const words = args.slice(i + 1, end < 0 ? undefined : end);
    if (words.length > 0) commands.push(words);
    if (end < 0) break;
    i = end;
  }
  return commands;
}

function classifyInvocation(words: string[], depth: number): BashVerdict {
  if (/[$`]|…/.test(words[0])) {
    return ask(
      "dynamic command",
      "the program name comes from a variable or substitution",
    );
  }
  const program = basename(words[0]);
  const args = words.slice(1);

  const inner = unwrap(program, args);
  if (inner === "none") return ALLOW;
  if (inner !== undefined) return classifyInvocation(inner, depth);

  if (SHELLS.has(program)) {
    const flagIndex = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    const script = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
    // Scripts from files or stdin cannot be inspected; they run sandboxed.
    return script !== undefined ? classify(script, depth + 1) : ALLOW;
  }
  if (program === "eval") return classify(args.join(" "), depth + 1);

  const nested = execArguments(program, args).map((command) =>
    classifyInvocation(command, depth + 1),
  );
  const rule = RULES[program];
  return combine([...nested, rule ? rule(args, program) : ALLOW]);
}

function classifySimpleCommand(
  command: SimpleCommand,
  depth: number,
): BashVerdict {
  let words = command.words;
  while (
    words.length > 0 &&
    (isAssignment(words[0]) || CONTROL_KEYWORDS.has(words[0]))
  )
    words = words.slice(1);
  if (words.length === 0) return ALLOW;
  if (words.length === 1 && BLOCK_END_KEYWORDS.has(words[0])) return ALLOW;
  // Loop/case headers; their bodies are separate commands and get checked on their own.
  if (LOOP_HEADERS.has(words[0])) return ALLOW;
  return classifyInvocation(words, depth);
}

function classify(command: string, depth: number): BashVerdict {
  if (depth > MAX_DEPTH)
    return ask("nested", "command nests too deeply to inspect");
  const parsed = parseCommandLine(command);
  if (parsed.problem)
    return ask("unparsed", `could not analyse the command (${parsed.problem})`);
  return combine([
    ...parsed.commands.map((c) => classifySimpleCommand(c, depth)),
    ...parsed.substitutions.map((sub) => classify(sub, depth + 1)),
  ]);
}

/**
 * Classify a bash command for plan mode. `sessionAllowed` holds ask-keys the
 * user approved for this session; they turn matching asks into allows but
 * never override a deny.
 */
export function classifyBashCommand(
  command: string,
  sessionAllowed: ReadonlySet<string> = new Set(),
): BashVerdict {
  const verdict = classify(command, 0);
  if (verdict.kind !== "ask") return verdict;
  const items = verdict.items.filter((item) => !sessionAllowed.has(item.key));
  return items.length === 0 ? ALLOW : { kind: "ask", items };
}
