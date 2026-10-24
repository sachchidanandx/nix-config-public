-- LSP servers provided by Nix (home.nix home.packages) instead of Mason.
-- nil: mason builds it from source with cargo, which fails because the
-- global git config rewrites https://github.com -> git@github.com.
-- gopls: mason-installed gopls was dynamically linked against a nix store
-- glibc that got garbage-collected (exec fails with ENOENT); the nixpkgs
-- gopls is updated with everything else on `nixsw`.
return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      nil_ls = { mason = false },
      gopls = { mason = false },
    },
  },
}
