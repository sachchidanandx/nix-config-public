# ============================================
# HISTORY CONFIGURATION
# ============================================

# History size (optimized for performance - 10k provides 6+ months coverage)
HISTSIZE=10000
SAVEHIST=10000

# History file location
HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"

# ============================================
# HISTORY OPTIONS
# ============================================

# Remove duplicate entries from history
setopt HIST_IGNORE_ALL_DUPS     # Remove all duplicates
setopt HIST_FIND_NO_DUPS        # Don't show duplicates in search
setopt HIST_SAVE_NO_DUPS        # Don't save duplicates

# Share history between sessions
setopt SHARE_HISTORY            # Share history instantly between sessions
setopt INC_APPEND_HISTORY       # Append immediately, not on exit

# Don't save certain commands
setopt HIST_IGNORE_SPACE        # Don't save commands starting with space
setopt HIST_NO_STORE            # Don't save 'history' command itself

# Better history behavior
setopt EXTENDED_HISTORY         # Save timestamp and duration
setopt HIST_EXPIRE_DUPS_FIRST   # Expire duplicates first when trimming
setopt HIST_VERIFY              # Show command before executing from history
setopt HIST_REDUCE_BLANKS       # Remove superfluous blanks
