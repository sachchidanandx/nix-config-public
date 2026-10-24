{
  description = "sachchidanandx dev environment (home-manager)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, home-manager, ... }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      # Dev loop: nix build .#pi --no-link --print-out-paths
      packages.${system} = {
        pi = pkgs.callPackage ./pkgs/pi { };
        # atac = pkgs.callPackage ./pkgs/atac { };

        # Home Manager CLI for the bootstrap (`nix run .#home-manager --
        # switch --flake .`). The home-manager input follows our nixpkgs, so
        # this builds against the pinned nixpkgs instead of a second one.
        home-manager = home-manager.packages.${system}.home-manager;
      };

      homeConfigurations.sachchidanandk = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [ ./home.nix ];
      };
    };
}
