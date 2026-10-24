# fzf key bindings + completion (fzf is installed by home-manager)
command -v fzf &>/dev/null && source <(fzf --zsh)

# Use 'fd' (including hidden files) for the plain 'fzf' command
export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow'

# Use the same 'fd' command for the Ctrl+T and Ctrl+F file search widget
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"

# fzf options with modern layout and Catppuccin Mocha theme
export FZF_DEFAULT_OPTS='
--height 40% --layout=reverse --border
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8
'
