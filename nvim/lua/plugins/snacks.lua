return {
  -- Always show hidden (dotfiles) in the explorer, while still respecting
  -- .gitignore. `.git/` stays hidden via the underlying fd/rg exclude args.
  {
    "folke/snacks.nvim",
    opts = {
      lazygit = {
        -- Don't generate a theme/editPreset config from the current
        -- colorscheme and append it to LG_CONFIG_FILE; we manage
        -- ~/.config/lazygit/config.yml ourselves (catppuccin mocha theme +
        -- nvim-remote edit commands that hide the float on file open).
        configure = false,
        -- Full-screen float instead of the default 90% centered one.
        -- (0 means full width/height in snacks.win)
        win = {
          style = "lazygit",
          width = 0,
          height = 0,
          border = "none", -- a border would cost 2 rows/cols at full size
        },
      },
      -- Open <leader>ft / <leader>fT terminals as centered floats
      -- (snacks' default is a bottom split).
      terminal = {
        win = {
          position = "float",
          border = "rounded",
          backdrop = false,
        },
      },
      picker = {
        sources = {
          explorer = {
            hidden = true, -- show dotfiles
            ignored = false, -- keep respecting .gitignore
            -- Open as a centered floating picker (like telescope-file-browser)
            -- instead of the default left sidebar.
            auto_close = true, -- close the float when it loses focus
            jump = { close = true }, -- close after opening a file
            layout = {
              preset = "default",
              preview = false,
              layout = {
                backdrop = false,
                width = 0.55,
                min_width = 0, -- ignore the default preset's min_width = 120
                height = 0.90,
              },
            },
          },
        },
      },
    },
  },
}
