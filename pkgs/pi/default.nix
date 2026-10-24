# pi-coding-agent from the upstream self-contained Bun binary release.
# Pinned in sources.json; run ./update.sh [X.Y.Z] to bump the pin.
{
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  lib,
  ripgrep,
  fd,
}:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);
  # Pinned to aarch64-linux, matching the flake's single exposed system.
  asset =
    if stdenvNoCC.hostPlatform.system == "aarch64-linux" then
      "pi-linux-arm64.tar.gz"
    else
      throw "pi: unsupported system ${stdenvNoCC.hostPlatform.system}";
  # PT_INTERP path fragment, for the install check below
  interpFragment = "ld-linux-aarch64";
in
stdenvNoCC.mkDerivation {
  pname = "pi-coding-agent-bin";
  inherit (sources) version;

  src = fetchurl {
    url = "https://github.com/earendil-works/pi/releases/download/v${sources.version}/${asset}";
    inherit (sources) sha256;
  };

  nativeBuildInputs = [ makeWrapper ];

  # The JS payload is embedded in the Mach-O; stripping or rewriting it would
  # break the payload or the ad-hoc signature.
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    # The binary finds its package dir via dirname(process.execPath), so the
    # whole release directory must stay together.
    # unpackPhase already cd's into the release's single top-level `pi/` dir.
    mkdir -p $out/libexec/pi
    cp -r . $out/libexec/pi
    makeWrapper $out/libexec/pi/pi $out/bin/pi \
      --prefix PATH : ${
        lib.makeBinPath [
          ripgrep
          fd
        ]
      } \
      --set-default PI_SKIP_VERSION_CHECK 1 \
      --set-default PI_TELEMETRY 0
    runHook postInstall
  '';

  # A broken package-dir layout shows up as version 0.0.0.
  # Native-only: a cross-build would try to execute the wrong-arch binary.
  doInstallCheck = stdenvNoCC.hostPlatform == stdenvNoCC.buildPlatform;
  installCheckPhase = ''
    # The host ELF loader (/lib/ld-linux-aarch64.so.*) is not present in
    # the build sandbox, so the binary cannot be executed here — check
    # that the installed asset is the right arch instead.
    test -x "$out/libexec/pi/pi"
    grep -qa "${interpFragment}" "$out/libexec/pi/pi"
  '';

  meta = {
    description = "pi-coding-agent, upstream Bun binary release";
    homepage = "https://github.com/earendil-works/pi";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "aarch64-linux" ];
    mainProgram = "pi";
  };
}
