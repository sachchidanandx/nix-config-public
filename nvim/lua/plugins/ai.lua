-- The `+ai` which-key group used to come from pi.nvim's `keys` list, which
-- meant pressing <leader>a lazy-loaded pi. It lives here now so the prefix is
-- agent-neutral and loads nothing; the keys under it are owned by whichever
-- agent is active (see lua/config/ai.lua).
return {
  {
    "folke/which-key.nvim",
    opts = {
      spec = {
        { "<leader>a", group = "ai", mode = { "n", "v" } },
      },
    },
  },
}
