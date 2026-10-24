-- Overrides for the `lazyvim.plugins.extras.ai.claudecode` extra.
--
-- The shared <leader>a keys live in lua/config/ai.lua and belong to whichever
-- agent is selected with <leader>aa, so the extra's own key list -- which
-- collides with pi's and binds <leader>aa to ClaudeCodeDiffAccept -- is
-- replaced wholesale here.
return {
  {
    "coder/claudecode.nvim",
    -- claudecode renders its terminal with Snacks.terminal (same machinery as
    -- pi.nvim and snacks.lazygit), so make sure snacks loads first.
    dependencies = { "folke/snacks.nvim" },
    cmd = {
      "ClaudeCode",
      "ClaudeCodeFocus",
      "ClaudeCodeOpen",
      "ClaudeCodeClose",
      "ClaudeCodeStart",
      "ClaudeCodeStop",
      "ClaudeCodeStatus",
      "ClaudeCodeSend",
      "ClaudeCodeSendText",
      "ClaudeCodeAdd",
      "ClaudeCodeTreeAdd",
      "ClaudeCodeSelectModel",
      "ClaudeCodeDiffAccept",
      "ClaudeCodeDiffDeny",
      "ClaudeCodeCloseAllDiffs",
    },
    -- A function REPLACES the merged key list; a table would be appended to
    -- the extra's keys instead (lazy.core.plugin.M._values).
    keys = function()
      return {}
    end,
    opts = {
      focus_after_send = true, -- mirrors pi's focus_on_send
      -- Leave track_selection at its default (true). Unlike pi's
      -- selection.track this is not just a background-broadcast toggle:
      -- selection.state.tracking_enabled also gates
      -- send_at_mention_for_visual_selection (and the getCurrentSelection /
      -- getLatestSelection MCP tools), so `false` makes visual-mode
      -- <leader>as / <leader>ap fail with "Selection tracking is not enabled."
      terminal = {
        -- Be explicit; "auto" would pick snacks here anyway, but both agents
        -- should use identical window machinery.
        provider = "snacks",
        -- Full-screen float like pi.nvim and snacks.lazygit (snacks treats
        -- width/height 0 as "full"). snacks_win_opts is deep-extended over
        -- claudecode's split defaults AND over the global snacks terminal
        -- style from lua/plugins/snacks.lua, which sets a rounded border --
        -- hence border = "none" here (a border costs 2 rows/cols at full size).
        snacks_win_opts = {
          position = "float",
          width = 0,
          height = 0,
          border = "none",
          backdrop = false,
        },
      },
    },
  },
}
