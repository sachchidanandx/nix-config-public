return {
  "akinsho/bufferline.nvim",
  opts = {
    options = {
      -- Don't truncate file names in tabs (default is 18)
      max_name_length = 100,
      max_prefix_length = 30,
      truncate_names = false,

      -- Show LSP diagnostics inline on the tab (error/warn icons)
      diagnostics = "nvim_lsp",
      diagnostics_indicator = function(count, level)
        local icon = level:match("error") and " " or " "
        return " " .. icon .. count
      end,

      -- Slanted separator style (alternatives: "slant", "slope", "padded_slant", "thin")
      separator_style = "slant",

      -- Hover to reveal close button, right-click to close
      hover = { enabled = true, delay = 200, reveal = { "close" } },
      close_command = function(n)
        Snacks.bufdelete(n)
      end,
      right_mouse_command = function(n)
        Snacks.bufdelete(n)
      end,

      -- Sort buffers by directory (nice grouping for monorepos)
      sort_by = "directory",

      -- Visual polish
      -- indicator = { style = "icon", icon = "▎" },
      show_close_icon = false,
      always_show_bufferline = true,
    },
  },
}
