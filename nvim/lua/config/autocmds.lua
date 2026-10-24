-- Disable spell checking (VSCode has its own spell checker)
if vim.g.vscode then
  vim.api.nvim_create_autocmd("FileType", {
    group = vim.api.nvim_create_augroup("vscode_no_spell", { clear = true }),
    pattern = { "text", "plaintex", "typst", "gitcommit", "markdown" },
    callback = function()
      vim.opt_local.spell = false
    end,
  })
end
