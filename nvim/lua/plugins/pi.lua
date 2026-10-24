return {
  {
    "sachchidanandx/pi.nvim",
    -- pi.nvim renders its terminal with Snacks.win (same machinery as
    -- snacks.lazygit), so make sure snacks loads first.
    dependencies = { "folke/snacks.nvim" },
    cmd = {
      "PiToggle",
      "PiResume",
      "PiNew",
      "PiRestart",
      "PiAdd",
      "PiSend",
      "PiPrompt",
      "PiStatus",
      "PiReview",
    },
    opts = {
      -- Each nvim instance owns one embedded pi session (1:1).
      position = "float", -- "float" | "left" | "right" | "bottom"
      -- Full-screen float like snacks.lazygit (snacks width/height = 0).
      float = {
        width = 1,
        height = 1,
        border = "none", -- a border would cost 2 rows/cols at full size
      },
      focus_on_send = true, -- enter the pi terminal after sending context
      selection = {
        track = false,
        debounce_ms = 150,
      },
    },
    -- All <leader>a keys are owned by the agent selected with <leader>aa;
    -- see lua/config/ai.lua. `cmd` keeps :Pi* usable without loading.
  },
}
