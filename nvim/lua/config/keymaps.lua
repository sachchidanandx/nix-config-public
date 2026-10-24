-- AI agent dispatch (<leader>aa/ac/an/as/ao/ap) -- see lua/config/ai.lua
require("config.ai").setup()

-- Terminal Close (<C-/>)
--
-- <C-/> only HIDES a visible floating terminal (AI agent or regular) -- it
-- never opens one. Open terminals explicitly with:
--   <leader>ft / <leader>fT → floating terminal (root dir / cwd)
--   <leader>ac / <leader>an / <leader>ao → AI agent terminal
-- This creates a natural flow:
--   <leader>ft → open floating terminal
--   <C-/>      → hide it (back to file buffer)
--   <leader>ac → open the active AI agent
--   <C-/>      → hide it (back to file buffer)

local function hide_visible_floating_terminal()
  -- A visible AI agent terminal (pi / claude) hides first. This only probes
  -- agents that are already loaded, so it never lazy-loads a plugin.
  if require("config.ai").hide_visible() then
    return true
  end
  for _, term in ipairs(Snacks.terminal.list()) do
    -- claudecode hides its float by config-hiding the window rather than
    -- closing it, so a hidden float still looks floating here -- skip those,
    -- otherwise <C-/> would report success without hiding anything.
    local win = term.win
    if
      term:is_floating()
      and win
      and vim.api.nvim_win_is_valid(win)
      and not vim.api.nvim_win_get_config(win).hide
    then
      term:hide()
      return true
    end
  end
  return false
end

vim.keymap.set({ "n", "t" }, "<c-/>", hide_visible_floating_terminal, { desc = "Close Floating Terminal" })

-- <C-_> is the same physical key as <C-/> on many terminals
vim.keymap.set({ "n", "t" }, "<c-_>", hide_visible_floating_terminal, { desc = "which_key_ignore" })

-- Ignore horizontal mouse-wheel events: trackpads emit these on slightly
-- diagonal two-finger scrolls, which slides the view sideways unexpectedly.
for _, mode in ipairs({ "n", "i", "v" }) do
  vim.keymap.set(mode, "<ScrollWheelLeft>", "<Nop>")
  vim.keymap.set(mode, "<ScrollWheelRight>", "<Nop>")
end

