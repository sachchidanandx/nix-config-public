// Run: node --test pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildBwrapArgs,
  buildProfile,
  isProfileError,
  isSandboxDenial,
  sandboxBackend,
  sandboxParams,
  shellQuote,
  wrapCommand,
} from "./sandbox.ts";

describe("buildProfile", () => {
  const profile = buildProfile();

  it("denies writes and re-allows the safe paths", () => {
    assert.match(profile, /^\(version 1\)\n\(allow default\)/);
    assert.match(profile, /\(deny file-write\*\)\n\(allow file-write\*\n/);
    for (const rule of [
      '(literal "/dev/null")',
      '(regex #"^/dev/fd/[0-9]+$")',
      '(subpath "/private/tmp")',
      '(subpath "/private/var/folders")',
      '(subpath (param "TMPDIR"))',
      '(subpath (string-append (param "HOME") "/.cache"))',
      '(subpath (string-append (param "HOME") "/Library/Caches"))',
    ]) {
      assert.ok(profile.includes(rule), rule);
    }
  });

  it("blocks the tmux socket", () => {
    assert.ok(
      profile.includes(
        '(deny network-outbound (remote unix-socket (path-regex #"^/private/tmp/tmux-")))',
      ),
    );
  });

  it("adds extra writable paths, escaped", () => {
    assert.ok(
      buildProfile(['/x/a "b"\\c']).includes('(subpath "/x/a \\"b\\"\\\\c")'),
    );
  });

  it("does not block the network", () => {
    assert.doesNotMatch(profile, /\(deny network\*|remote ip/);
  });
});

describe("shellQuote / wrapCommand", () => {
  const run = (script: string) =>
    spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" }).stdout;

  for (const value of [
    "plain",
    "it's",
    "a'b'c",
    "$(echo no)",
    "`echo no`",
    "line1\nline2",
    "back\\slash",
    '"dq"',
    "",
  ]) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      assert.equal(run(`printf %s ${shellQuote(value)}`), value);
    });
  }

  it("builds the sandbox-exec command line", () => {
    const wrapped = wrapCommand("echo 'hi'", {
      shell: "/bin/bash",
      params: { home: "/Users/me", tmpdir: "/private/tmp/t" },
      backend: "seatbelt",
    });
    assert.equal(
      wrapped,
      `exec /usr/bin/sandbox-exec -p ${shellQuote(buildProfile())} -D 'HOME=/Users/me' -D 'TMPDIR=/private/tmp/t' '/bin/bash' -c 'echo '\\''hi'\\'''`,
    );
  });

  it("keeps quotes, newlines and substitutions in the command intact", () => {
    const command = `printf '%s' "it's $(echo ok) \`echo no\`\nback\\slash"`;
    const wrapped = wrapCommand(command, {
      shell: "/bin/bash",
      params: { home: "/Users/me", tmpdir: "/private/tmp/t" },
      backend: "seatbelt",
    });
    assert.ok(wrapped.endsWith(`-c ${shellQuote(command)}`));
    // The quoted command survives a shell round-trip: /bin/bash receives it verbatim.
    const result = spawnSync(
      "/bin/sh",
      ["-c", `/bin/bash -c ${shellQuote(`printf %s ${shellQuote(command)}`)}`],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, command);
  });
});

describe("error detection", () => {
  it("recognises profile errors", () => {
    assert.ok(
      isProfileError(65, "sandbox-exec: unbound variable: x at /tmp/p.sb"),
    );
    assert.ok(
      isProfileError(71, "sandbox-exec: execvp() of '/bin/nope' failed"),
    );
    assert.ok(!isProfileError(65, "my tool exited 65"));
    assert.ok(!isProfileError(1, "sandbox-exec: something"));
    assert.ok(isProfileError(1, "bwrap: Can't find source path /x"));
    assert.ok(isProfileError(1, "bwrap: setting up uid map: Permission denied", "bwrap"));
    assert.ok(!isProfileError(1, "note: bwrap: mentioned", "bwrap"));
    assert.ok(!isProfileError(1, "bwrap: boom", "seatbelt"));
    assert.ok(!isProfileError(65, "sandbox-exec: x", "bwrap"));
  });

  it("recognises denials as tools report them", () => {
    assert.ok(isSandboxDenial("touch: x: Operation not permitted"));
    assert.ok(isSandboxDenial("bash: x: Operation not permitted"));
    assert.ok(
      isSandboxDenial(
        "PermissionError: [Errno 1] Operation not permitted: 'x'",
      ),
    );
    assert.ok(
      isSandboxDenial(
        "error connecting to /private/tmp/tmux-501/default (Operation not permitted)",
      ),
    );
    assert.ok(
      isSandboxDenial(
        "fatal: Unable to create '/x/.git/refs/heads/y': Operation not permitted",
      ),
    );
    assert.ok(isSandboxDenial("mkdir: [Errno 1] Operation not permitted"));
    assert.ok(isSandboxDenial("cmd -x: rm -rf: Operation not permitted"));
    assert.ok(!isSandboxDenial("Permission denied"));
  });

  it("recognises EROFS denials from read-only bind mounts", () => {
    assert.ok(isSandboxDenial("touch: cannot touch 'x': Read-only file system"));
    assert.ok(
      isSandboxDenial("mkdir: cannot create directory 'd': Read-only file system"),
    );
    assert.ok(
      isSandboxDenial("OSError: [Errno 30] Read-only file system: 'x'"),
    );
    assert.ok(
      isSandboxDenial(
        "fatal: Unable to create '/x/.git/index.lock': Read-only file system",
      ),
    );
    assert.ok(
      !isSandboxDenial('writes fail with "Read-only file system" while planning'),
    );
  });

  it("ignores the phrase when it is only quoted text", () => {
    assert.ok(
      !isSandboxDenial(
        'bash runs in a sandbox (writes fail with "Operation not permitted")',
      ),
    );
    assert.ok(
      !isSandboxDenial(
        "+- (deny file-write*) — writes fail with `Operation not permitted`",
      ),
    );
    assert.ok(
      !isSandboxDenial(
        "+- sandbox note: Operation not permitted gets a note appended",
      ),
    );
  });
});

describe(
  "sandbox-exec (live)",
  { skip: sandboxBackend() !== "seatbelt" && "seatbelt not available" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sbx-test-"));
    const params = sandboxParams();
    const sandboxed = (command: string) =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          wrapCommand(command, {
            shell: "/bin/bash",
            params,
            backend: "seatbelt",
          }),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      );

    it("allows reads and scratch writes", () => {
      const scratch = join(dir, "scratch.txt");
      const result = sandboxed(
        `cat /etc/hosts > /dev/null && echo ok > ${shellQuote(scratch)} && f=$(mktemp) && rm "$f"`,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(scratch, "utf8"), "ok\n");
    });

    it("blocks writes in the home folder", () => {
      const target = join(params.home, `.pi-sbx-test-${process.pid}`);
      const result = sandboxed(`echo x > ${shellQuote(target)}`);
      const created = existsSync(target);
      if (created) rmSync(target);
      assert.equal(created, false);
      assert.notEqual(result.status, 0);
      assert.ok(isSandboxDenial(result.stderr), result.stderr);
    });

    it("reports a broken profile as a profile error", () => {
      const bad = "(version 1)(allow default)(bogus)";
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", bad, "/bin/bash", "-c", "true"],
        { encoding: "utf8" },
      );
      assert.ok(
        isProfileError(result.status ?? undefined, result.stderr, "seatbelt"),
        `${result.status} ${result.stderr}`,
      );
    });

    it("runs the real profile with quotes and substitutions intact", () => {
      const result = sandboxed(`printf '%s' "it's $(echo ok)"`);
      assert.equal(result.stdout, "it's ok", result.stderr);
    });

    it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
  },
);

describe("buildBwrapArgs / wrapCommand (bwrap)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bwrap-args-"));
  const home = join(root, "home");
  const homeCache = join(home, ".cache");
  const fixtureTmp = join(root, "tmp");
  const tmuxTmp = join(root, "tmuxtmp");
  const uid = process.getuid!();
  const socket = join(tmuxTmp, `tmux-${uid}`, "default");
  const params = { home, tmpdir: fixtureTmp };
  mkdirSync(homeCache, { recursive: true });
  mkdirSync(fixtureTmp);
  mkdirSync(join(tmuxTmp, `tmux-${uid}`), { recursive: true });
  writeFileSync(socket, ""); // stands in for a tmux server socket
  const env = { TMUX_TMPDIR: tmuxTmp, PATH: join(root, "bin") };

  it("lays out read-only / plus writable re-binds and tmux shadows", () => {
    const args = buildBwrapArgs("echo hi", {
      shell: "/bin/bash",
      params,
      env,
    });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--bind", "/tmp", "/tmp",
      "--bind", fixtureTmp, fixtureTmp,
      "--bind", homeCache, homeCache,
      "--ro-bind", "/dev/null", socket,
      "--die-with-parent", "--", "/bin/bash", "-c", "echo hi",
    ]);
    // ~/.npm does not exist in the fixture home: skipped (bwrap would abort).
    assert.ok(!args.some((a) => a.includes(".npm")));
  });

  it("dedupes $TMPDIR equal to /tmp", () => {
    const args = buildBwrapArgs("true", {
      shell: "/bin/bash",
      params: { home, tmpdir: "/tmp" },
      env,
    });
    // Exactly one /tmp bind (deduped), plus the fixture cache.
    const binds = args.filter((a, i) => args[i - 1] === "--bind");
    assert.deepEqual(binds, ["/tmp", homeCache]);
  });

  it("skips tmux shadowing when no server dir exists", () => {
    const args = buildBwrapArgs("true", {
      shell: "/bin/bash",
      params,
      env: { TMUX_TMPDIR: join(root, "no-such-dir"), PATH: env.PATH },
    });
    assert.ok(!args.includes("/dev/null"));
  });

  it("wrapCommand resolves bwrap from PATH and quotes the command", () => {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeBwrap = join(binDir, "bwrap");
    writeFileSync(fakeBwrap, "#!/bin/sh\n");
    chmodSync(fakeBwrap, 0o755);
    const wrapped = wrapCommand("echo 'hi'", {
      shell: "/bin/bash",
      params,
      backend: "bwrap",
      env: { TMUX_TMPDIR: tmuxTmp, PATH: binDir },
    });
    assert.ok(
      wrapped.startsWith(
        `exec ${shellQuote(fakeBwrap)} '--ro-bind' '/' '/' '--dev' '/dev' '--proc' '/proc'`,
      ),
      wrapped,
    );
    assert.ok(wrapped.endsWith(`'-c' ${shellQuote("echo 'hi'")}`), wrapped);
    assert.ok(wrapped.includes(shellQuote(socket)), wrapped);
  });

  it("cleans up", () => rmSync(root, { recursive: true, force: true }));
});

describe(
  "bwrap (live)",
  { skip: sandboxBackend() !== "bwrap" && "bwrap not available" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bwrap-live-"));
    const params = sandboxParams();
    const sandboxed = (command: string, cwd?: string) =>
      spawnSync(
        "/bin/sh",
        [
          "-c",
          wrapCommand(command, {
            shell: "/bin/bash",
            params,
            backend: "bwrap",
          }),
        ],
        {
          encoding: "utf8",
          cwd,
          // Linux usually has no TMPDIR; give $TMPDIR a defined value here.
          env: { ...process.env, TMPDIR: params.tmpdir, GIT_OPTIONAL_LOCKS: "0" },
        },
      );

    it("allows scratch writes under $TMPDIR", () => {
      const result = sandboxed(`touch "$TMPDIR/pi-plan-bwrap-test" && echo ok`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "ok");
      assert.ok(existsSync(join(params.tmpdir, "pi-plan-bwrap-test")));
      rmSync(join(params.tmpdir, "pi-plan-bwrap-test"), { force: true });
    });

    it("blocks writes in the home folder (EROFS)", () => {
      const target = join(params.home, "pi-plan-bwrap-test");
      const result = sandboxed('touch "$HOME/pi-plan-bwrap-test"');
      const created = existsSync(target);
      if (created) rmSync(target);
      assert.equal(created, false);
      assert.notEqual(result.status, 0);
      assert.ok(isSandboxDenial(result.stderr), result.stderr);
    });

    it("blocks writes in the project directory (EROFS)", () => {
      const result = sandboxed("touch ./pi-plan-bwrap-test", process.cwd());
      assert.notEqual(result.status, 0);
      assert.ok(isSandboxDenial(result.stderr), result.stderr);
      assert.ok(!existsSync(join(process.cwd(), "pi-plan-bwrap-test")));
    });

    it("keeps /dev/stdout and process substitution working (fresh /dev)", () => {
      // Re-opening an *inherited* pipe via /dev/stdout fails with ENXIO in a
      // user namespace (kernel pipefs is per-userns); a file-backed stdout
      // works, and pipes created inside the sandbox (process substitution)
      // work. Redirect to a file first, then write through /dev/stdout.
      const out = join(dir, "stdout.txt");
      const viaFile = sandboxed(`exec > ${shellQuote(out)} && echo hi > /dev/stdout`);
      assert.equal(viaFile.status, 0, viaFile.stderr);
      assert.equal(readFileSync(out, "utf8"), "hi\n");
      const proc = sandboxed("diff <(echo a) <(echo a) && echo ok");
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(proc.stdout.trim(), "ok");
    });

    it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
  },
);
