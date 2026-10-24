# ~/.zshenv
# Sourced on all shells. Keep this MINIMAL for performance.

# ============================================
# ZSH CONFIG DIRECTORY (must be first)
# ============================================
export ZDOTDIR="$HOME/.config/zsh"

export XDG_CONFIG_HOME="$HOME/.config"

# ============================================
# NIX + HOME-MANAGER
# ============================================
[ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ] && \
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
[ -e "$HOME/.nix-profile/etc/profile.d/hm-session-vars.sh" ] && \
    . "$HOME/.nix-profile/etc/profile.d/hm-session-vars.sh"

# ============================================
# DEFAULT PROGRAMS
# ============================================
export EDITOR="nvim"
export VISUAL="$EDITOR"
export PAGER="less"

# ============================================
# PATH
# ============================================
# Dedupe: nested shells (tmux) re-source this file and would stack entries
typeset -U path PATH
export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH"

# ============================================
# PERFORMANCE
# ============================================
skip_global_compinit=1
