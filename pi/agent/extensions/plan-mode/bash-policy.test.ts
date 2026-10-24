// Run: node --test pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBashCommand, parseCommandLine } from "./bash-policy.ts";

const kind = (command: string, allowed?: string[]) =>
  classifyBashCommand(command, new Set(allowed)).kind;
const keys = (command: string) => {
  const verdict = classifyBashCommand(command);
  return verdict.kind === "ask" ? verdict.items.map((item) => item.key) : [];
};

function expectAll(expected: "allow" | "deny" | "ask", commands: string[]) {
  for (const command of commands) {
    it(`${expected}: ${command.replace(/\n/g, "\\n")}`, () => {
      assert.equal(kind(command), expected);
    });
  }
}

describe("allow: reads (local and network)", () => {
  expectAll("allow", [
    "ls -la",
    "cat README.md | head -20",
    "rg -n 'foo' src --glob '*.ts'",
    "find . -name '*.nix' -type f",
    "(cd nvim && git log --oneline -5)",
    "git -C ~/src/pi.nvim status --short",
    "git -c core.pager=less log",
    "git ls-remote --heads origin",
    "git fetch origin",
    "gh pr view 123 --json title,body",
    "gh pr list --state all",
    "gh pr diff 123",
    "gh run view 1 --log",
    "gh -R o/r issue list",
    "gh api repos/o/r/pulls",
    "gh api -X GET repos/o/r/issues -f state=open",
    "gh api graphql -f query='query { viewer { login } }'",
    "gh auth status",
    "gh search repos pi",
    "curl -sSL https://example.com",
    "curl -I https://example.com",
    "curl -o /tmp/page.html https://example.com",
    "curl -G -d q=1 https://example.com/search",
    "wget -qO- https://example.com",
    "http GET example.com",
    "http example.com q==1 Accept:application/json",
    "dig example.com",
    "nix eval .#darwinConfigurations",
    "nix flake show",
    "nix flake update",
    "nix build --dry-run .#foo",
    "nix store ls /nix/store/x",
    "nix profile list",
    "kubectl get pods -n kube-system",
    "kubectl -n foo describe pod bar",
    "kubectl config use-context x",
    "helm list -A",
    "terraform plan",
    "terraform state list",
    "aws sts get-caller-identity",
    "aws --region eu-west-1 ec2 describe-instances",
    "aws s3 ls s3://bucket",
    "gcloud compute instances list",
    "az group list",
    "brew list --versions",
    "brew info jq",
    "docker ps -a",
    "docker compose ps",
    "docker image ls",
    "launchctl list",
    "defaults read -g AppleLocale",
    "security find-generic-password -s x",
    "crontab -l",
    "kill -l",
    "ssh -V",
    "tmux -V",
    "code --version",
    "nvim --headless -c 'q'",
    "npm view left-pad version",
    "npm ls --depth=0",
    "npm dist-tag ls pkg",
  ]);
});

describe("allow: local writes and code (the sandbox handles them)", () => {
  expectAll("allow", [
    "echo hi > /tmp/out.txt",
    "cat a > b",
    "rm -rf build",
    "sed -i '' s/a/b/ file",
    "git commit -m x",
    "npm install lodash",
    "python3 -c 'print(1)'",
    "node -e \"require('fs').rmSync('x')\"",
    "./script.sh",
    "bash script.sh",
    "make",
    "npm run build",
    "terraform init",
    "gh repo clone o/r",
    "gh pr checkout 12",
    "gh config set editor nvim",
    "cat <<EOF > /tmp/x\n$(date)\nEOF",
    "cat <<'EOF'\n$(gh pr create)\nEOF",
    "diff <(ls a) <(ls b)",
    "echo $((1 + 2))",
    'for f in *.ts; do wc -l "$f"; done',
    "if [ -f x ]; then cat x; fi",
    "FOO=1 env | sort",
    "sleep 1 &",
    "source .envrc",
  ]);
});

describe("ask: side effects the sandbox cannot see", () => {
  expectAll("ask", [
    "git push",
    "git push origin main --force",
    "git -C repo push",
    "git send-email x.patch",
    "git lfs push origin",
    "gh pr create --fill",
    "gh pr merge 1",
    "gh pr comment 1 -b hi",
    "gh issue close 3",
    "gh release create v1",
    "gh workflow run ci.yml",
    "gh secret set X",
    "gh repo fork",
    "gh browse",
    "gh auth login",
    "gh api -X POST repos/o/r/issues",
    "gh api --method=DELETE repos/o/r",
    "gh api repos/o/r/issues -f title=x",
    "gh api graphql -f query='mutation { addStar(input:{}) { clientMutationId } }'",
    "curl -X POST https://example.com",
    "curl -XPUT https://example.com",
    "curl -d 'a=1' https://example.com",
    "curl --json '{}' https://example.com",
    "curl -F f=@x https://example.com",
    "curl -T file https://example.com",
    "wget --post-data=a=1 https://example.com",
    "http POST example.com a=1",
    "http example.com name=x",
    "xh example.com n:=1",
    "ssh host uptime",
    "scp x host:/tmp",
    "rsync -a dir host:dir",
    "nc -l 8080",
    "kubectl apply -f x.yaml",
    "kubectl delete pod x",
    "kubectl rollout restart deploy/x",
    "helm upgrade --install x chart",
    "terraform apply",
    "tofu destroy",
    "terraform state rm x",
    "pulumi up",
    "aws s3 cp x s3://b/x",
    "aws ec2 terminate-instances --instance-ids i-1",
    "gcloud run deploy svc",
    "az vm start -n x",
    "nix build .#foo",
    "nix profile install nixpkgs#jq",
    "nix store gc",
    "nix copy --to ssh://h .#x",
    "nix-collect-garbage -d",
    "nix-store --delete /nix/store/x",
    "nix-env -iA nixpkgs.jq",
    "darwin-rebuild switch --flake .",
    "home-manager switch",
    "brew install jq",
    "brew services start x",
    "docker run --rm alpine",
    "docker compose up -d",
    "docker image rm x",
    "podman push img",
    "npm publish",
    "pnpm publish",
    "cargo publish",
    "uv publish",
    "gem push x.gem",
    "twine upload dist/*",
    "launchctl kickstart -k gui/501/x",
    "defaults write com.apple.dock autohide -bool true",
    "osascript -e 'tell app \"Finder\" to quit'",
    "open https://example.com",
    "shortcuts run X",
    "security add-generic-password -s x -a y -w z",
    "crontab file",
    "systemctl restart nginx",
    "kill 1234",
    "pkill node",
    "sudo ls",
    "code .",
    "nvim --server /tmp/nvim.sock --remote-send ':q<CR>'",
  ]);
});

describe("deny", () => {
  expectAll("deny", [
    "reboot",
    "sudo -h; shutdown -h now",
    "tmux ls",
    "tmux send-keys -t 0 'rm -rf ~' Enter",
    "vim file",
  ]);
});

describe("nesting", () => {
  expectAll("ask", [
    "bash -c 'git push'",
    'sh -c "ls && gh pr create"',
    "echo $(git push)",
    'echo "`gh pr merge 1`"',
    "cat <<EOF\n$(git push)\nEOF",
    "eval git push",
    "env FOO=1 git push",
    "timeout 30 git push",
    "nohup kubectl apply -f x &",
    "xargs -n1 gh issue close < ids",
    "find . -name '*.pid' -exec kill {} \\;",
    "fd -e yaml -x kubectl apply -f",
    "command git push",
    "/usr/bin/git push",
    "$GIT push",
  ]);

  it("collects every side effect", () => {
    assert.deepEqual(keys("git push && gh pr create && git push"), [
      "git push",
      "gh pr create",
    ]);
  });
});

describe("session approvals", () => {
  it("turns remembered asks into allows", () => {
    assert.equal(kind("git push", ["git push"]), "allow");
    assert.equal(kind("gh pr create --fill", ["gh pr create"]), "allow");
  });
  it("only removes the approved keys", () => {
    const verdict = classifyBashCommand(
      "git push && gh pr create",
      new Set(["git push"]),
    );
    assert.equal(verdict.kind, "ask");
    assert.deepEqual(
      verdict.kind === "ask" && verdict.items.map((i) => i.key),
      ["gh pr create"],
    );
  });
  it("never overrides a deny", () => {
    assert.equal(kind("git push; reboot", ["git push", "reboot"]), "deny");
  });
});

describe("unparsable commands ask", () => {
  expectAll("ask", ["echo 'unterminated", "cat <<EOF\n$(echo\nEOF"]);
});

describe("parser", () => {
  it("splits operators and keeps fd redirects off the word list", () => {
    const parsed = parseCommandLine("a 2>&1 | b && c; d");
    assert.deepEqual(
      parsed.commands.map((c) => c.words),
      [["a"], ["b"], ["c"], ["d"]],
    );
    assert.deepEqual(parsed.commands[0].redirects, [{ op: ">&", target: "1" }]);
  });
  it("collects substitutions for recursive checks", () => {
    assert.deepEqual(parseCommandLine('echo "$(a) `b`" <(c)').substitutions, [
      "a",
      "b",
      "c",
    ]);
  });
  it("skips heredoc bodies but keeps their substitutions", () => {
    const parsed = parseCommandLine(
      "cat <<-EOF\n\trm -rf / $(x) `y` $((1+1))\n\tEOF\nls",
    );
    assert.deepEqual(
      parsed.commands.map((c) => c.words),
      [["cat"], ["ls"]],
    );
    assert.deepEqual(parsed.substitutions, ["x", "y"]);
  });
  it("ignores substitutions in quoted heredocs", () => {
    assert.deepEqual(
      parseCommandLine("cat <<'EOF'\n$(x)\nEOF").substitutions,
      [],
    );
  });
});
