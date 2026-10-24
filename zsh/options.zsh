# ============================================
# ZSH OPTIONS - Better shell behavior
# ============================================

# ============================================
# DIRECTORY NAVIGATION
# ============================================
setopt AUTO_CD              # Type directory name to cd into it
setopt AUTO_PUSHD           # Make cd push old directory onto stack
setopt PUSHD_IGNORE_DUPS    # Don't push duplicates
setopt PUSHD_SILENT         # Don't print directory stack
setopt PUSHD_TO_HOME        # pushd with no args goes home
setopt CDABLE_VARS          # Allow cd to variables

# ============================================
# GLOBBING & EXPANSION
# ============================================
setopt EXTENDED_GLOB        # Use extended globbing syntax
setopt GLOB_DOTS            # Include dotfiles in globbing
setopt NOMATCH              # Error if glob doesn't match
setopt NUMERIC_GLOB_SORT    # Sort globs numerically when possible

# ============================================
# COMPLETION
# ============================================
setopt ALWAYS_TO_END        # Move cursor to end after completion
setopt AUTO_MENU            # Show completion menu on tab
setopt AUTO_LIST            # List choices on ambiguous completion
setopt AUTO_PARAM_SLASH     # Add trailing slash for dirs
setopt COMPLETE_IN_WORD     # Complete from both ends of word
setopt LIST_PACKED          # Variable column widths in menu

# ============================================
# CORRECTION & INPUT
# ============================================
setopt CORRECT              # Correct commands (not args)
setopt NO_BEEP              # Don't beep on error
setopt INTERACTIVE_COMMENTS # Allow comments in interactive shell

# ============================================
# JOB CONTROL
# ============================================
setopt LONG_LIST_JOBS       # List jobs in long format
setopt AUTO_RESUME          # Resume jobs when typing name
setopt NOTIFY               # Report status immediately
setopt NO_BG_NICE           # Don't nice background jobs
setopt NO_HUP               # Don't kill jobs on shell exit
setopt NO_CHECK_JOBS        # Don't warn about running jobs on exit

# ============================================
# PERFORMANCE
# ============================================
setopt NO_FLOW_CONTROL      # Disable Ctrl-S/Ctrl-Q flow control
