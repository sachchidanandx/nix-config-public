# atac (Arguably a Terminal API Client, TUI API client) from the upstream
# static musl binary release. Pinned in sources.json; run ./update.sh [X.Y.Z]
# to bump the pin.
{
  stdenvNoCC,
  fetchurl,
  installShellFiles,
  lib,
}:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);
  # Static musl build: no interpreter, no runtime deps, works on any glibc.
  asset =
    if stdenvNoCC.hostPlatform.system == "aarch64-linux" then
      "atac-v${sources.version}-aarch64-unknown-linux-musl.tar.gz"
    else
      throw "atac: unsupported system ${stdenvNoCC.hostPlatform.system}";
in
stdenvNoCC.mkDerivation {
  pname = "atac-bin";
  inherit (sources) version;

  src = fetchurl {
    url = "https://github.com/Julien-cpsn/ATAC/releases/download/v${sources.version}/${asset}";
    inherit (sources) sha256;
  };

  nativeBuildInputs = [ installShellFiles ];

  # The release tarball is a single top-level `atac` file (no directory),
  # which the default unpackPhase rejects; unpack it manually instead.
  dontUnpack = true;

  # Static musl binary executes fine inside the sandbox: generate the shell
  # completions and man page from the binary itself (shell names must be
  # lowercase, e.g. `zsh` not `Zsh`).
  installPhase = ''
    runHook preInstall
    tar -xzf "$src"
    # The completions/man subcommands create ~/.config/atac; give the
    # sandbox a writable HOME first.
    export HOME="$(mktemp -d)"
    install -Dm755 atac "$out/bin/atac"
    completions_dir="$(mktemp -d)"
    man_dir="$(mktemp -d)"
    "$PWD/atac" completions zsh "$completions_dir"
    "$PWD/atac" completions bash "$completions_dir"
    "$PWD/atac" completions fish "$completions_dir"
    "$PWD/atac" man "$man_dir"
    installShellCompletion --zsh --name _atac "$completions_dir/_atac"
    installShellCompletion --bash --name atac.bash "$completions_dir/atac.bash"
    installShellCompletion --fish --name atac.fish "$completions_dir/atac.fish"
    installManPage "$man_dir/atac.1"
    runHook postInstall
  '';

  doInstallCheck = stdenvNoCC.hostPlatform == stdenvNoCC.buildPlatform;
  installCheckPhase = ''
    "$out/bin/atac" --version | grep -q "${sources.version}"
  '';

  meta = {
    description = "atac, Arguably a Terminal API Client (TUI API client)";
    homepage = "https://github.com/Julien-cpsn/ATAC";
    license = lib.licenses.mit; # verified MIT via the GitHub API (repo LICENSE)
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "aarch64-linux" ];
    mainProgram = "atac";
  };
}
