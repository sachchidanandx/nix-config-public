# ============================================
# EDITOR ALIASES (EDITOR is set in .zshenv)
# ============================================
alias vim="nvim"
alias vi="nvim"
alias v="nvim"
alias view="nvim -R"

# Quick edit common config files
alias zshrc="$EDITOR ~/.config/zsh/.zshrc"
alias zshenv="$EDITOR ~/.zshenv"
alias aliases="$EDITOR ~/.config/zsh/aliases.zsh"
alias nvimrc="$EDITOR ~/.config/nvim/init.lua"
alias starshipconf="$EDITOR ~/.config/zsh/starship.toml"

# ============================================
# NAVIGATION
# ============================================
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias .....="cd ../../../.."

# Quick directory jumps
alias ~="cd ~"
alias -- -="cd -"  # Go to previous directory

# Create and enter directory
mkcd() {
    mkdir -p "$1" && cd "$1"
}

# ============================================
# EZA (Modern ls replacement)
# ============================================
if command -v eza &>/dev/null; then
    alias ls='eza --group-directories-first'
    alias l='eza --icons --oneline'
    alias ll='eza --icons --long --header --git'
    alias la='eza --icons --long --all --header --git'
    alias lt='eza --icons --tree --level=2'
    alias lta='eza --icons --tree --level=2 --all'
    alias ltree='eza --icons --tree'
    alias tree='eza --tree --git-ignore'
fi

# ============================================
# BAT (Modern cat replacement)
# ============================================
if command -v bat &>/dev/null; then
    alias cat='bat --style=auto'
    alias catp='bat --style=plain'
    alias cath='bat --style=header'
fi

# ============================================
# FD (Modern find replacement)
# ============================================
if command -v fd &>/dev/null; then
    alias find='fd'
fi

# ============================================
# RIPGREP (Modern grep replacement)
# ============================================
if command -v rg &>/dev/null; then
    alias grep='rg'
fi

# ============================================
# SYSTEM
# ============================================
# Reload shell
alias reload='exec zsh'
alias src='source ~/.config/zsh/.zshrc'

# Show PATH in readable format
alias path='echo $PATH | tr ":" "\n"'

# Get public IP
alias myip='curl -s ifconfig.me'
alias localip='hostname -I'

# ============================================
# FILE OPERATIONS (with safety)
# ============================================
alias cp='cp -iv'    # Interactive, verbose
alias mv='mv -iv'    # Interactive, verbose
alias rm='rm -i'     # Interactive
alias mkdir='mkdir -pv'  # Create parents, verbose

# Disk usage
alias du='du -h'
alias df='df -h'

# Human-readable sizes
alias duh='du -h -d 1 | sort -hr'

# ============================================
# TMUX
# ============================================
if command -v tmux &>/dev/null; then
    alias t='tmux'
    alias ta='tmux attach'
    alias tn='tmux new -s'
    alias tl='tmux list-sessions'
    alias tk='tmux kill-session -t'
fi

# ============================================
# NIX
# ============================================
# Update everything: bump pinned packages (pi), then flake inputs, then
# apply. A failed version bump only warns so it does not block flake input
# updates and the switch.
nixup() {
    ~/nix-config/pkgs/pi/update.sh || echo "nixup: pi bump failed, continuing" >&2
    nix flake update --flake ~/nix-config &&
    home-manager switch --flake ~/nix-config
}
# Apply the nix-config home-manager configuration. Extra flags pass
# through, e.g. `nixsw --dry-run`.
nixsw() {
    command home-manager switch --flake ~/nix-config "$@"
}

# Garbage-collect the Nix store. Keeps old generations (rollbacks) intact;
# extra flags pass through, e.g. `nixgc --dry-run`.
nixgc() {
    local before after
    before=$(command du -sh /nix/store | cut -f1)
    echo "nix store before: $before"
    command nix-collect-garbage "$@"
    after=$(command du -sh /nix/store | cut -f1)
    echo "nix store after:  $after"
}

# Remove old rollbacks (generations) of every user profile, then GC to free
# the space they held. Only the current generation of each profile survives —
# there is no undo. Run after `nixsw`/`home-manager switch` builds up generations.
nixrmrollback() {
    local p
    for p in "$HOME"/.local/state/nix/profiles/*(N); do
        [[ "$p" == *-link ]] && continue   # skip the per-generation symlinks
        [[ -e "$p" ]] || continue
        echo "wiping old generations: $p"
        command nix profile wipe-history --profile "$p"
    done
    nixgc
}

# Quick log viewing
alias logs='journalctl -f'

# Show listening ports
alias listening='lsof -iTCP -sTCP:LISTEN -n -P'

# ============================================
# SAFETY ALIASES
# ============================================

# Safer chmod
alias chmod='chmod -v'
alias chown='chown -v'

# ============================================
# DEVELOPMENT SHORTCUTS
# ============================================

# Edit and reload config instantly
zshconfig() {
    $EDITOR ~/.config/zsh/.zshrc && source ~/.config/zsh/.zshrc
}

# Quick port killing
killport() {
    lsof -ti:$1 | xargs kill -9
}
