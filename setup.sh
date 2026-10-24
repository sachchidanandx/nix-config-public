#!/usr/bin/env bash
# Bootstrap a new VM from this repo:
#
#   git clone https://github.com/sachchidanandx/nix-config-public.git ~/nix-config
#   ~/nix-config/setup.sh
#
# Installs Determinate Nix if missing, checks that the flake's system matches
# the machine's arch, applies home-manager, and makes Nix's zsh the login
# shell. Idempotent: re-running it is a `nixsw` plus the Nix/login-shell checks.
set -euo pipefail

# `git checkout` below rewrites this file while bash is still reading it (bash
# reads scripts incrementally), so re-exec a snapshot first. The repo path
# travels in the environment because BASH_SOURCE no longer points at it.
if [ -n "${NIX_CONFIG_SETUP_REPO:-}" ]; then
  repo="$NIX_CONFIG_SETUP_REPO"
else
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  export NIX_CONFIG_SETUP_REPO="$repo"
  exec bash -c "$(cat "$repo/setup.sh")" setup.sh "$@"
fi

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: setup.sh [--help]

Bootstrap this VM from this repo: install Determinate Nix if missing, check
that the flake's system matches the machine's arch, apply home-manager, and
make Nix's zsh the login shell.
Safe to re-run; a re-run is a `nixsw` plus the Nix/login-shell checks.

The repo must live at ~/nix-config (home.nix and the nixsw/nixup aliases
hardcode that path). See README.md, section "New machine".
EOF
}

# TLS interception: curl reads SSL_CERT_FILE; node (used by installers in
# home.nix) reads NODE_EXTRA_CA_CERTS.
trust_ca() {
  local ca=/etc/ssl/certs/ca-certificates.crt
  if [ -f "$ca" ]; then
    export SSL_CERT_FILE="${SSL_CERT_FILE:-$ca}"
    export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$ca}"
  fi
}

preflight() {
  [ "$(uname -s)" = Linux ] || die "this configuration targets Linux"
  [ "$(id -u)" -ne 0 ] || die "run as your own user, not root (home-manager would target /root)"
  [ "$(id -un)" = sachchidanandk ] \
    || die "this branch hardcodes user sachchidanandk (flake.nix homeConfigurations + home.nix); adjust both for user $(id -un)"
  [ "$HOME" = /home/sachchidanandk ] \
    || die "this branch hardcodes homeDirectory /home/sachchidanandk; adjust flake.nix/home.nix for $HOME"
  if [ ! -e "$HOME/nix-config" ] ||
     [ "$(cd "$HOME/nix-config" && pwd -P)" != "$repo" ]; then
    die "the repo must be at ~/nix-config (home.nix and the nixsw/nixup aliases hardcode that path); it is at $repo — move it with: mv '$repo' ~/nix-config"
  fi
  command -v git >/dev/null || die "git is required (it ships with the clone)"
  command -v curl >/dev/null || die "curl is required to download the Nix installer: sudo apt-get install -y curl"
  command -v sudo >/dev/null || die "sudo is required for the Nix install and the login-shell change"
}

arch_system() {
  case "$(uname -m)" in
    aarch64 | arm64) printf 'aarch64-linux\n' ;;
    x86_64 | amd64) printf 'x86_64-linux\n' ;;
    *) printf '\n' ;;
  esac
}

flake_system() {
  sed -n 's/^[[:space:]]*system = "\([^"]*\)";.*/\1/p' "$repo/flake.nix" | head -n1
}

ensure_branch() {
  local want have
  want="$(arch_system)"
  [ -n "$want" ] || die "unsupported arch $(uname -m); edit flake.nix (system) and home.nix for your platform"
  have="$(flake_system)"
  [ -n "$have" ] || die "could not read the pinned system from $repo/flake.nix"
  if [ "$have" != "$want" ]; then
    die "this checkout targets $have but this machine is $want; edit flake.nix (system) and home.nix, then re-run"
  fi
  step "flake targets $have (matches this machine)"
}

install_nix() {
  export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
  if command -v nix >/dev/null 2>&1; then
    step "Nix already installed: $(nix --version)"
    return 0
  fi
  if [ -e /nix ]; then
    die "/nix exists but nix is not on PATH; finish or remove that install first (https://github.com/DeterminateSystems/nix-installer)"
  fi

  local -a install_args=(install --no-confirm)
  if [ ! -d /run/systemd/system ]; then
    warn "systemd not found; installing with --init none (then only root can run Nix)"
    install_args+=(--init none)
  fi
  step "installing Determinate Nix (sudo prompt expected; a few minutes)"
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
    | sh -s -- "${install_args[@]}"

  # shellcheck disable=SC1091
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
  command -v nix >/dev/null || die "Nix installed, but the nix binary is not on PATH"
  step "Nix installed: $(nix --version)"
}

ensure_store() {
  if nix store ping >/dev/null 2>&1; then
    return 0
  fi
  warn "the Nix daemon is not answering; trying to restart it"
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart nix-daemon.service || true
  fi
  nix store ping >/dev/null 2>&1 \
    || die "Nix store is unreachable; check: sudo systemctl status nix-daemon"
}

apply_home_manager() {
  local state_dir="${XDG_STATE_HOME:-$HOME/.local/state}"
  local -a args=(switch)
  if [ ! -e "$state_dir/nix/profiles/home-manager" ]; then
    args+=(-b hm-backup) # first run: back up pre-existing dotfiles instead of failing
    step "first home-manager activation (downloads the nixpkgs closure; expect 10-30 minutes)"
  else
    step "applying home-manager configuration"
  fi
  args+=(--flake "$repo")
  nix --extra-experimental-features "nix-command flakes" \
    run "$repo#home-manager" -- "${args[@]}"
}

set_login_shell() {
  local zsh_bin="$HOME/.nix-profile/bin/zsh" current
  [ -x "$zsh_bin" ] || die "zsh is missing from the profile; did the switch succeed?"
  if command -v getent >/dev/null 2>&1; then
    current="$(getent passwd "$(id -un)" | cut -d: -f7)"
  else
    current="$(awk -F: -v u="$(id -un)" '$1 == u { print $7 }' /etc/passwd)"
  fi
  if [ "$current" = "$zsh_bin" ]; then
    step "login shell already $zsh_bin"
    return 0
  fi
  if ! sudo -n true 2>/dev/null && [ ! -t 0 ]; then
    warn "sudo cannot prompt here; set the login shell manually:"
    warn "  echo $zsh_bin | sudo tee -a /etc/shells && sudo chsh -s $zsh_bin $(id -un)"
    return 0
  fi
  if ! grep -qxF "$zsh_bin" /etc/shells; then
    printf '%s\n' "$zsh_bin" | sudo tee -a /etc/shells >/dev/null
  fi
  sudo chsh -s "$zsh_bin" "$(id -un)"
  step "login shell set to $zsh_bin (takes effect on the next login)"
}

summary() {
  local branch
  branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ ! -f "$repo/zsh/secrets.zsh" ]; then
    warn "zsh/secrets.zsh is missing (untracked API keys). Create it, then re-run setup.sh or nixsw:"
    warn "  cp $repo/zsh/secrets.zsh.example $repo/zsh/secrets.zsh && \$EDITOR $repo/zsh/secrets.zsh"
  fi

  cat <<EOF

Done — this machine matches the $branch branch of ~/nix-config.

  exec zsh        start zsh now (new logins use it after you log out/in)
  gh auth login   then one-time: tsh login, claude, pi (each interactive)
  nixsw           apply any later change in this repo (dotfiles, home.nix)
  nixup           bump the pi pin + flake inputs, then apply
  setup.sh        re-run this bootstrap (safe; nixsw plus Nix/login-shell checks)

EOF
}

main() {
  trust_ca
  preflight
  ensure_branch
  install_nix
  ensure_store
  apply_home_manager
  set_login_shell
  summary
}

case "${1:-}" in
  "") ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) die "unknown argument: $1 (try --help)" ;;
esac

main
