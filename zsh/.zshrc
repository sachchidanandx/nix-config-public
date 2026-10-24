# ~/.config/zsh/.zshrc
# Optimized for fast startup and smooth daily use

# Plugins and tools are installed by home-manager (~/nix-config/home.nix)
ZSH_PLUGIN_DIR="$HOME/.nix-profile/share"

# ============================================
# DEPENDENCY GUARD
# ============================================
if ! command -v starship &>/dev/null || ! command -v fzf &>/dev/null \
    || [[ ! -d "${ZSH_PLUGIN_DIR}/zsh-autosuggestions" ]]; then
    printf '\033[1;33m[zsh]\033[0m Missing dependencies detected.\n'
    printf '      Run: home-manager switch --flake ~/nix-config\n'
fi

# ============================================
# ZSH OPTIONS (Load early for best behavior)
# ============================================
[ -f "${ZDOTDIR}/options.zsh" ] && source "${ZDOTDIR}/options.zsh"

# ============================================
# COMPLETION SYSTEM (Early, optimized)
# ============================================
fpath=($HOME/.docker/completions $fpath)

autoload -Uz compinit
if [[ -f ${ZDOTDIR}/.zcompdump && $(date +'%j') != $(date -r ${ZDOTDIR}/.zcompdump +'%j' 2>/dev/null) ]]; then
    compinit -d "${ZDOTDIR}/.zcompdump"
else
    compinit -C -d "${ZDOTDIR}/.zcompdump"
fi

# Compile the completion dump to bytecode for faster loading.
# Recompile only when the dump is newer than the compiled version.
if [[ -s "${ZDOTDIR}/.zcompdump" && ( ! -s "${ZDOTDIR}/.zcompdump.zwc" || "${ZDOTDIR}/.zcompdump" -nt "${ZDOTDIR}/.zcompdump.zwc" ) ]]; then
    zcompile "${ZDOTDIR}/.zcompdump"
fi

# ============================================
# COMPLETION SETTINGS (After compinit)
# ============================================
[ -f "${ZDOTDIR}/completion.zsh" ] && source "${ZDOTDIR}/completion.zsh"

# ============================================
# ZSH-VI-MODE (Must load BEFORE other plugins)
# ============================================
if [[ -f ${ZSH_PLUGIN_DIR}/zsh-vi-mode/zsh-vi-mode.plugin.zsh ]]; then
    source ${ZSH_PLUGIN_DIR}/zsh-vi-mode/zsh-vi-mode.plugin.zsh
    # Use 'jk' to exit insert mode
    ZVM_VI_INSERT_ESCAPE_BINDKEY=jk
    # Faster key response
    export KEYTIMEOUT=1
else
    # Fallback to basic vim mode
    bindkey -v
    export KEYTIMEOUT=1

    # Load edit-command-line widget
    autoload -z edit-command-line
    zle -N edit-command-line
    bindkey '^e' edit-command-line
fi

# ============================================
# HISTORY
# ============================================
[ -f "${ZDOTDIR}/history.zsh" ] && source "${ZDOTDIR}/history.zsh"

# Skip mail checking (performance)
MAILCHECK=0

# ============================================
# ALIASES
# ============================================
[ -f "${ZDOTDIR}/aliases.zsh" ] && source "${ZDOTDIR}/aliases.zsh"

# ============================================
# KEY BINDINGS
# ============================================
[ -f "${ZDOTDIR}/keybindings.zsh" ] && source "${ZDOTDIR}/keybindings.zsh"

# ============================================
# FZF
# ============================================
[ -f "${ZDOTDIR}/fzf.zsh" ] && source "${ZDOTDIR}/fzf.zsh"

# ============================================
# DEVBOX
# ============================================
[ -f "${ZDOTDIR}/devbox.zsh" ] && source "${ZDOTDIR}/devbox.zsh"

# ============================================
# SECRETS
# ============================================
[ -f "${ZDOTDIR}/secrets.zsh" ] && source "${ZDOTDIR}/secrets.zsh"

# ============================================
# ZSH PLUGINS (Load late for performance)
# ============================================
# Fast syntax highlighting
if [[ -f ${ZSH_PLUGIN_DIR}/zsh/plugins/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh ]]; then
    source ${ZSH_PLUGIN_DIR}/zsh/plugins/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh
fi

# Autosuggestions (with performance tuning)
if [[ -f ${ZSH_PLUGIN_DIR}/zsh-autosuggestions/zsh-autosuggestions.zsh ]]; then
    source ${ZSH_PLUGIN_DIR}/zsh-autosuggestions/zsh-autosuggestions.zsh
    ZSH_AUTOSUGGEST_MANUAL_REBIND=1
    ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20
    ZSH_AUTOSUGGEST_USE_ASYNC=1
fi

# Autopair
if [[ -f ${ZSH_PLUGIN_DIR}/zsh/zsh-autopair/autopair.zsh ]]; then
    source ${ZSH_PLUGIN_DIR}/zsh/zsh-autopair/autopair.zsh
fi

# System clipboard — removed: zsh-vi-mode already provides yank-to-clipboard,
# so zsh-system-clipboard was redundant and added ~3ms to startup.

# ============================================
# DIRENV (per-project nix shells; installed via home-manager)
# ============================================
if command -v direnv &>/dev/null; then
    eval "$(direnv hook zsh)"
fi

# ============================================
# STARSHIP PROMPT (Load last)
# ============================================
# Using Catppuccin theme directly from submodule
export STARSHIP_CONFIG="${ZDOTDIR}/starship.toml"
eval "$(starship init zsh)"
