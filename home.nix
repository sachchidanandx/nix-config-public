{
  config,
  lib,
  pkgs,
  ...
}:

let
  repo = "${config.home.homeDirectory}/nix-config";

  # Store-backed link: the flake source is copied into the Nix store at eval
  # time and Home Manager symlinks into that copy, so config edits apply only
  # on the next `nixsw`. Files apps rewrite at runtime must NOT use this
  # (they'd be read-only store symlinks) — use `mutable` below instead.
  link = path: ./${path};

  # Files apps rewrite at runtime (pi /mcp toggles, Claude Code,
  # LazyVim's lockfiles): symlink straight into the repo
  # working tree instead of the store (a store symlink is read-only and
  # the app's writes would fail). App edits land in the repo directly.
  mutable = path: config.lib.file.mkOutOfStoreSymlink "${repo}/${path}";

  # nvim without the files LazyVim rewrites at runtime (deployed as repo
  # symlinks by `mutable` below): a store symlink there would make
  # lazy-lock.json etc. read-only and LazyVim writes would fail.
  nvimSrc = lib.cleanSourceWith {
    src = ./nvim;
    name = "nvim-config";
    filter =
      path: type:
      !builtins.elem (baseNameOf path) [
        "lazy-lock.json"
        "lazyvim.json"
        ".neoconf.json"
      ];
  };

  # Run a curl|bash installer once, only if ~/.local/bin/<bin> is missing.
  # Activation doesn't inherit the shell's CA env, and the global git config's
  # https->ssh rewrite would need ssh + an agent, so bypass it for clones.
  installIfMissing =
    bin: url:
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      if [[ ! -x "$HOME/.local/bin/${bin}" ]]; then
        export PATH="${
          lib.makeBinPath [
            pkgs.curl
            pkgs.git
            pkgs.nodejs
            pkgs.bash
          ]
        }:$PATH"
        export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
        export NODE_EXTRA_CA_CERTS=$SSL_CERT_FILE
        export GIT_CONFIG_GLOBAL=/dev/null
        run bash -c 'curl -fsSL ${url} | bash'
      fi
    '';

  # secrets.zsh must never enter the store: install it from the repo working
  # tree (gitignored) only if present and differing. One-way repo->home; it
  # is never synced back.
  secretsScript = pkgs.writeShellScript "install-secrets-zsh" ''
    set -euo pipefail
    export PATH=${lib.makeBinPath [ pkgs.coreutils ]}:$PATH
    src=${lib.escapeShellArg repo}/zsh/secrets.zsh
    dst="$HOME/.config/zsh/secrets.zsh"
    if [[ ! -f "$src" ]]; then
      exit 0
    fi
    if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
      install -m 600 "$src" "$dst"
    fi
  '';
in
{
  targets.genericLinux.enable = true;

  # Lima guest on macOS: there is no host GPU and /run/opengl-driver is never
  # populated (the setup script wants sudo on the guest). The module defaults
  # this to true, which makes every switch print
  # "This non-NixOS system is not yet set up to use the GPU ...".
  targets.genericLinux.gpu.enable = false;

  # Per-project nix shells auto-activated on cd. enableZshIntegration is
  # intentionally left to the manual hook in zsh/.zshrc because zsh is
  # managed as dotfiles (xdg.configFile), not programs.zsh.
  programs = {
    home-manager.enable = true;

    direnv = {
      enable = true;
      nix-direnv.enable = true;
    };

    git = {
      enable = true;
      lfs.enable = true;
      ignores = [
        "**/.claude/.cc-writes/"
        "**/.claude/settings.local.json"
        # pi plan-mode plan files; `**/` so it matches below the repo root too
        "**/.pi/plans/"
        # nix / direnv local dev
        "**/shell.nix"
        "**/.envrc"
        "**/.direnv/"
      ];
      settings = {
        user.name = "Sachchidanand Kumar";
        user.email = "sachchidanandx@gmail.com";
        init.defaultBranch = "main";
        core.editor = "nvim";
        url."git@github.com:".pushInsteadOf = "https://github.com/";
      };
      includes = [
        {
          condition = "gitdir:~/nix-config/";
          contents.user = {
            name = "sachchidanandx";
            email = "sachchidanandx@gmail.com";
          };
        }
      ];
    };
  };

  home = {
    username = "sachchidanandk";
    homeDirectory = "/home/sachchidanandk";
    stateVersion = "26.05";

    packages = with pkgs; [
      # shell
      zsh
      starship
      zsh-vi-mode
      zsh-fast-syntax-highlighting
      zsh-autosuggestions
      zsh-autopair

      # modern CLI
      eza
      bat
      fd
      ripgrep
      fzf
      jq
      curl
      unzip
      ast-grep
      tcpdump
      htop
      awscli2
      teleport.client # tsh-only output of pkgs.teleport (default output also builds the server)
      bruno-cli # @usebruno/cli (npm pkg, packaged in nixpkgs); provides the `bru` command

      # editor / multiplexer / git
      neovim
      tmux
      lazygit
      k9s
      kubectl
      gh

      # AI coding agents (nvim/lua/config/ai.lua); pi is the upstream Bun
      # binary pinned in pkgs/pi/sources.json (pkgs/pi/update.sh bumps it)
      (pkgs.callPackage ./pkgs/pi { })
      # atac (Arguably a Terminal API Client, TUI API client); static musl
      # binary pinned in pkgs/atac/sources.json (pkgs/atac/update.sh bumps it)
      # (pkgs.callPackage ./pkgs/atac { })

      # toolchains needed by LazyVim extras, treesitter and Mason
      gcc
      gnumake
      tree-sitter
      nodejs
      pnpm
      python314
      uv
      go
      # Go LSP (LazyVim lang.go extra; mason-installed gopls was patched
      # against a GC'd nix glibc and died — see nvim/lua/plugins/lsp.lua)
      gopls
      golangci-lint
      rustc
      cargo
      rustfmt
      clippy
      rust-analyzer
      # nix language LSP/formatter/linter (LazyVim lang.nix extra; nil_ls has
      # mason = false in nvim/lua/plugins/lsp.lua, so mason never builds it)
      nil
      nixfmt
      statix
    ];

    file = {
      ".zshenv".source = link "zsh/.zshenv";
      ".claude/statusline.sh".source = link "claude/statusline.sh";
      ".claude/commands".source = link "claude/commands";
      ".claude/settings.json".source = mutable "claude/settings.json";
      ".pi/agent/prompts".source = link "pi/agent/prompts";
      ".pi/agent/extensions".source = link "pi/agent/extensions";
      ".pi/agent/mcp.json".source = mutable "pi/agent/mcp.json";
      ".pi/agent/settings.json".source = mutable "pi/agent/settings.json";
      # nvim's runtime files; the rest of nvim is the recursive xdg.configFile
      # below (nvimSrc excludes exactly these three so there is no collision)
      ".config/nvim/lazy-lock.json".source = mutable "nvim/lazy-lock.json";
      ".config/nvim/lazyvim.json".source = mutable "nvim/lazyvim.json";
      ".config/nvim/.neoconf.json".source = mutable "nvim/.neoconf.json";
    };

    activation = {
      # Installed by its own installer rather than nixpkgs: the native build
      # self-updates, and nixpkgs lags upstream by weeks.
      installClaudeCode = installIfMissing "claude" "https://claude.ai/install.sh";

      installSecretsZsh = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        run bash ${secretsScript}
      '';

      # Ghostty exports TERM=xterm-ghostty; ssh/`limactl shell` propagate it
      # into the guest, whose Ubuntu-minimal terminfo db lacks the entry.
      # Compile it into ~/.terminfo (ncurses searches ~/.terminfo by default).
      # Do NOT "fix" this by overriding TERM in the guest: tmux.conf enables
      # extkeys only for xterm-ghostty, so a TERM downgrade would silently
      # drop CSI-u extended keys (ctrl+shift+tab) inside guest tmux.
      installGhosttyTerminfo = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run ${pkgs.ncurses}/bin/tic -x -o "$HOME/.terminfo" ${./terminfo/xterm-ghostty.ti}
      '';
    };
  };

  xdg.configFile = {
    # recursive = true: ~/.config/<dir> becomes a real directory with
    # per-file store symlinks, so gitignored runtime files (.zsh_history,
    # state.yml, ...) can live in $HOME. Tracked files are store symlinks
    # (read-only; changes apply on nixsw).
    "zsh" = {
      source = link "zsh";
      recursive = true;
    };
    "nvim" = {
      source = nvimSrc;
      recursive = true;
    };
    "lazygit" = {
      source = link "lazygit";
      recursive = true;
    };
    # tmux needs a real dir: TPM and plugins are cloned into
    # ~/.config/tmux/plugins (gitignored) by tmux.conf's auto-install block.
    "tmux" = {
      source = link "tmux";
      recursive = true;
    };
    # Read-only, no runtime writes: plain dir symlinks are enough.
    "k9s".source = link "k9s";
    # only config.yml: gh writes auth state (hosts.yml) next to it
    "gh/config.yml".source = link "gh/config.yml";
  };
}
