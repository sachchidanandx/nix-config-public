return {
  "MagicDuck/grug-far.nvim",
  opts = {
    -- use ast-grep for structural search by default
    -- (can still switch to ripgrep per-search via the engine toggle in the UI)
    engine = "astgrep",

    -- open the grug-far panel as a full-height split on the far left
    windowCreationCommand = "topleft vsplit",

    -- open result files in the window to the right of grug-far,
    -- reusing that window's buffer instead of creating new splits
    -- (valid values: "prev" | "left" | "right" | "above" | "below")
    openTargetWindow = {
      preferredLocation = "right",
      -- open real file buffers (with LSP) instead of temporary scratch buffers
      useScratchBuffer = false,
    },

    -- keep the grug-far panel open when jumping to a result
    -- (LazyVim default is transient = true, which closes it)
    transient = false,
  },
}
