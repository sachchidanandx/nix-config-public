# ============================================
# KEY BINDINGS (Universal - work in both vi and emacs mode)
# ============================================

# History navigation
bindkey '^p' up-line-or-history
bindkey '^n' down-line-or-history
bindkey '^[[A' up-line-or-search
bindkey '^[[B' down-line-or-search

# Delete key
bindkey '^[[3~' delete-char
bindkey '^?' backward-delete-char

# Home and End keys
bindkey '^[[H' beginning-of-line
bindkey '^[[F' end-of-line

# Alt+Left/Right for word navigation
bindkey '^[[1;3C' forward-word
bindkey '^[[1;3D' backward-word

# Ctrl+Left/Right for word navigation
bindkey '^[[1;5C' forward-word
bindkey '^[[1;5D' backward-word
