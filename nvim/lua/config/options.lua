-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- LazyVim defaults to sidescrolloff = 8, which makes the view slide sideways
-- while mouse-scrolling whenever the cursor gets near the window edge, even
-- when lines are shorter than the screen. Disable that horizontal margin.
vim.opt.sidescrolloff = 0

-- OSC 52 clipboard over SSH: make yanks reach the Mac clipboard through the
-- terminal (Ghostty/WezTerm/kitty/Alacritty all support OSC 52). LazyVim
-- disables clipboard sync under SSH by default (clipboard = ""), so we opt back
-- in via OSC 52. Guarded by SSH_CONNECTION so local-Mac behavior is unchanged.
if vim.env.SSH_CONNECTION then
  vim.opt.clipboard = "unnamedplus"
  local osc52 = require("vim.ui.clipboard.osc52")
  vim.g.clipboard = {
    name = "OSC 52",
    copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
    paste = { ["+"] = osc52.paste("+"), ["*"] = osc52.paste("*") },
  }
end

-- Hide tmux from everything nvim spawns (:terminal, snacks terminals, claude,
-- pi, ...). Jobs inherit TMUX/TERM_PROGRAM=tmux, assume their parent terminal
-- IS tmux, and wrap OSC queries/clipboard sequences (OSC 11, OSC 52) in tmux
-- DCS passthrough. nvim's :terminal is the real parent and doesn't unwrap
-- them, so they bounce back as typed input ("11;?", "52;c;<base64>...").
-- Safe for nvim itself: the TUI is a separate process that detected tmux
-- before this runs; only :checkhealth and the non-macOS clipboard fallback
-- read $TMUX here.
for _, var in ipairs({ "TMUX", "TMUX_PANE", "TERM_PROGRAM", "TERM_PROGRAM_VERSION" }) do
  vim.env[var] = nil
end

-- Embedded terminals (:terminal, snacks terminals behind <leader>ft, ...)
-- default to $SHELL, which is still bash in sessions started before the
-- login shell was switched to zsh in /etc/passwd. Pin zsh so nvim terminals
-- are zsh regardless of what the launching shell was.
vim.opt.shell = "zsh"
