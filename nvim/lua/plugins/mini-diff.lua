return {
  {
    "nvim-mini/mini.diff",
    event = "VeryLazy",
    keys = {
      {
        "<leader>go",
        function()
          require("mini.diff").toggle_overlay(0)
        end,
        desc = "Toggle mini.diff overlay",
      },
    },
    opts = {
      -- gitsigns.nvim owns the gutter signs, navigation, staging, blame, etc.
      -- mini.diff is only used for the inline buffer overlay toggled with
      -- <leader>go.
      --
      -- Use style = "number" instead of "sign" so mini.diff NEVER places
      -- sign-column extmarks. mini.diff's sign style has priority 199 vs
      -- gitsigns' 6, so its (empty-text) signs were masking gitsigns' gutter
      -- glyphs and the gutter flickered depending on when mini.diff attached
      -- (it auto-enables on BufEnter). With "number" style it only tints line
      -- numbers, and the config callback below neutralises even that tint.
      view = {
        style = "number",
      },
      -- Disable all of mini.diff's global mappings so it never competes with
      -- gitsigns. Only the <leader>go overlay key above is used.
      mappings = {
        apply = "",
        reset = "",
        textobject = "",
        goto_first = "",
        goto_prev = "",
        goto_next = "",
        goto_last = "",
      },
    },
    config = function(_, opts)
      require("mini.diff").setup(opts)
      -- Make mini.diff's remaining "number" style visualisation invisible:
      -- link its highlight groups to LineNr so the number column looks exactly
      -- as it would without mini.diff. These links are non-default, so
      -- mini.diff's own `default = true` re-links on ColorScheme won't
      -- override them. mini.diff is then purely an engine for the overlay.
      vim.api.nvim_set_hl(0, "MiniDiffSignAdd", { link = "LineNr" })
      vim.api.nvim_set_hl(0, "MiniDiffSignChange", { link = "LineNr" })
      vim.api.nvim_set_hl(0, "MiniDiffSignDelete", { link = "LineNr" })
    end,
  },
}
