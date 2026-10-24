-- Fix PATH for GUI launches (Neovide): macOS GUI apps don't source the
-- shell rc files, so nvm's node is missing and node-based LSP servers fail
-- with exit code 127 ("env: node: No such file or directory").
if vim.fn.executable("node") == 0 then
  local nvm_dir = vim.fn.expand("~/.nvm")
  -- Resolve the nvm default alias chain (default -> lts/* -> vXX.Y.Z)
  local version
  local ok, lines = pcall(vim.fn.readfile, nvm_dir .. "/alias/default")
  local depth = 0
  if ok and lines[1] then
    version = vim.trim(lines[1])
    while version and depth < 5 do
      local f = nvm_dir .. "/alias/" .. version
      if vim.fn.filereadable(f) == 1 then
        version = vim.trim(vim.fn.readfile(f)[1] or "")
        depth = depth + 1
      else
        break
      end
    end
  end
  local bin = version and (nvm_dir .. "/versions/node/" .. version .. "/bin")
  if bin and vim.fn.isdirectory(bin) == 1 then
    vim.env.PATH = bin .. ":" .. vim.env.PATH
  end
end

-- bootstrap lazy.nvim, LazyVim and your plugins
require("config.lazy")
