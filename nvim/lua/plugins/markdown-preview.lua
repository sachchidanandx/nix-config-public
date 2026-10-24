return {
  "iamcco/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  build = function()
    require("lazy").load({ plugins = { "markdown-preview.nvim" } })
    vim.fn["mkdp#util#install"]()
    -- yarn rewrites app/yarn.lock (registry.npmjs.org vs registry.yarnpkg.com
    -- URLs), which makes lazy.nvim refuse future updates; restore it after
    -- the install so the plugin clone stays clean. node_modules is already
    -- installed by then, so the preview keeps working.
    local dir = require("lazy.core.config").plugins["markdown-preview.nvim"].dir
    vim.system({ "git", "-C", dir, "checkout", "--", "app/yarn.lock" }):wait()
    vim.system({
      "git", "-C", dir, "clean", "-f", "--",
      "app/package-lock.json", "app/pnpm-lock.yaml",
    }):wait()
  end,
  keys = {
    { "<leader>cp", ft = "markdown", "<cmd>MarkdownPreviewToggle<cr>", desc = "Markdown Preview" },
  },
}
