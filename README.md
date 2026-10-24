# nix-config

My dev environment (zsh, tmux, nvim/LazyVim, Claude Code) managed with
[Nix](https://nixos.org) + [home-manager](https://github.com/nix-community/home-manager)
on Ubuntu (standalone, Nix only — no apt).

## Branch

`main` — Ubuntu 26.04, `aarch64-linux`, standalone home-manager (no
nix-darwin). This is a public mirror of my own config: the internal `nsk`
package and the work-only settings are not included.

```
flake.nix     # pins nixpkgs + home-manager versions (see flake.lock)
home.nix      # packages to install + which config files get deployed where
setup.sh      # one-shot bootstrap for a new VM (see "New machine")
zsh/          # -> ~/.config/zsh  (and zsh/.zshenv -> ~/.zshenv)
nvim/         # -> ~/.config/nvim (minus the three LazyVim runtime files)
tmux/         # -> ~/.config/tmux
terminfo/     # xterm-ghostty.ti compiled into ~/.terminfo by home-manager activation
lazygit/      # -> ~/.config/lazygit
k9s/          # -> ~/.config/k9s
gh/           # config.yml -> ~/.config/gh/config.yml
claude/       # statusline.sh + commands/ -> ~/.claude/ (settings.json: repo symlink)
pi/           # agent/{prompts,extensions} -> ~/.pi/agent/ (settings.json, mcp.json: repo symlinks)
pkgs/pi/      # pi from the upstream Bun binary: per-platform sources.json pin, update.sh bumps it
```

## Deployment model

Configs are deployed from the Nix store: every `nixsw` re-copies this repo
into the store and re-points the symlinks, so **editing a config here changes
nothing in `~` until the next `nixsw`** — same for `home.nix` / `flake.nix`.
Two kinds of files:

- **Store symlinks (default, read-only).** Each tracked config file lands in
  `~` as a symlink into `/nix/store`. `zsh`, `nvim` and `lazygit` are deployed
  per-file, so their gitignored runtime files (`.zsh_history`, `.zcompdump*`,
  `state.yml`, …) live as real files in `~/.config/<dir>/` and survive
  switches.
- **Working-tree symlinks (`mutable` in `home.nix`).** The handful of
  files apps rewrite at runtime — pi's `agent/mcp.json` + `agent/settings.json`,
  Claude's `settings.json`, and nvim's `lazy-lock.json`/`lazyvim.json`/
  `.neoconf.json` — are symlinked straight into this repo's working tree
  (`mkOutOfStoreSymlink`), so app edits show up in `git status` immediately
  and repo edits to them apply without a switch.

Recipe: if some other app starts writing into a config file, add a `mutable`
entry to `home.file` in `home.nix` (2-line fix) and `nixsw` — writes into a
store symlink fail (read-only).

`zsh/secrets.zsh` never enters the store: it stays untracked (gitignored)
here, and each `nixsw` installs it to `~/.config/zsh/secrets.zsh` (mode 600)
if it differs. It is sourced from `.zshrc`.

## New machine

Two steps. The only prerequisite is `git` for the clone.

```sh
# 1. Clone the repo to ~/nix-config (the path is hardcoded in home.nix and the
#    nixsw/nixup aliases).
git clone https://github.com/sachchidanandx/nix-config-public.git ~/nix-config
# 2. Bootstrap: installs Determinate Nix if missing, checks that the flake's
#    system matches this machine, applies home-manager, and makes Nix's zsh
#    the login shell.
~/nix-config/setup.sh
```

`setup.sh` is idempotent — re-running it is a `nixsw` plus the Nix/login-shell
checks — and it requires the checkout to stay at `~/nix-config` (the `mutable`
symlinks in `home.nix` and the `nixsw`/`nixup` aliases hardcode that path). The
first run downloads the whole nixpkgs closure, so budget 10–30 minutes.

The steps it automates, if you ever need them by hand:

```sh
# Nix (Determinate, multi-user with systemd; add `--init none` without systemd)
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install --no-confirm
# First apply — uses the home-manager CLI exposed by this flake, so no second
# nixpkgs is downloaded
nix run ~/nix-config#home-manager -- switch -b hm-backup --flake ~/nix-config
# Login shell
echo ~/.nix-profile/bin/zsh | sudo tee -a /etc/shells && chsh -s ~/.nix-profile/bin/zsh
```

TLS interception: if your network inspects TLS, add its root CA to the system
bundle. `setup.sh` and home.nix's installer activation scripts export
`SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` pointing at
`/etc/ssl/certs/ca-certificates.crt`; export it yourself if a curl|bash step
still hits TLS errors.

Username, home directory and system (`aarch64-linux`, with an arch-independent
flake) are hardcoded in `flake.nix` / `home.nix`; adjust them for a different
machine.

## Everyday use

| Task                           | Command                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| Apply any change (configs too) | `home-manager switch --flake ~/nix-config` (alias `nixsw`)                               |
| Add a package                  | add it to `home.packages` in `home.nix`, then apply                                       |
| Find a package name            | `nix search nixpkgs <name>` or <https://search.nixos.org>                                 |
| Try a tool without installing  | `nix shell nixpkgs#<pkg>`                                                                |
| Update all package versions    | `nix flake update` then apply (commit `flake.lock`) (run `nixup`, which also bumps the pi pin) |
| Update only pi                 | `pkgs/pi/update.sh [X.Y.Z]` then apply (commit `pkgs/pi/sources.json`)                                |
| List / roll back generations   | `home-manager generations`, then run `<path>/activate` of an older one                    |
| Free disk space                | `nix-collect-garbage --delete-older-than 30d`                                            |

Flakes only see files tracked by git: `git add` new files before applying.

## Jira / Confluence for pi

pi talks to the hosted Atlassian MCP server (Rovo) — configured in
`pi/agent/mcp.json`, sign in with `pi mcp login atlassian`.

pi also talks to a hosted Slack MCP server, likewise in `pi/agent/mcp.json`;
sign in per server with `pi mcp login <name>`. Slack's auth server has no
dynamic client registration, so its entry pins the client ID Slack publishes
for its Claude plugin (redirect `http://localhost:3118/callback`; see
<https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude/>).

## Per-project environments (next step)

Put a `flake.nix` in a project to pin that project's own toolchain,
independent of this global setup:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs = { nixpkgs, ... }:
    let pkgs = nixpkgs.legacyPackages.aarch64-linux; in {
      devShells.aarch64-linux.default = pkgs.mkShell {
        packages = [ pkgs.go pkgs.nodejs_22 ];
      };
    };
}
```

Then `nix develop` in that directory drops you into a shell with exactly
those tools. Adding `direnv` + `nix-direnv` (via `programs.direnv` in
`home.nix`) makes this automatic on `cd`.
