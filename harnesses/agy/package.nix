# Google's prebuilt binary, as its installer unpacks it: the tarball's
# `antigravity`, run as `agy`, with the self-updater off.
{ lib
, stdenv
, fetchurl
, autoPatchelfHook
, makeBinaryWrapper
, writableTmpDirAsHomeHook
}:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);
  system = stdenv.hostPlatform.system;
  source = sources.sources.${system} or (throw "Antigravity CLI: unsupported system ${system}");
in
stdenv.mkDerivation {
  pname = "agy";
  inherit (sources) version;
  src = fetchurl { inherit (source) url hash; };
  sourceRoot = ".";
  nativeBuildInputs = [ makeBinaryWrapper ] ++ lib.optional stdenv.hostPlatform.isElf autoPatchelfHook;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 antigravity "$out/libexec/agy"
    # It replaces itself in the background otherwise; a store path cannot be
    # replaced, and the daily update moves the pin instead.
    makeBinaryWrapper "$out/libexec/agy" "$out/bin/agy" \
      --set AGY_CLI_DISABLE_AUTO_UPDATE true
    runHook postInstall
  '';
  nativeInstallCheckInputs = [ writableTmpDirAsHomeHook ];
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    actual=$("$out/bin/agy" --version </dev/null)
    printf 'Antigravity CLI version: %s\n' "$actual"
    test "$actual" = ${lib.escapeShellArg sources.version}
    runHook postInstallCheck
  '';
  meta = {
    description = "Antigravity CLI, Google's coding agent, from its prebuilt binaries";
    homepage = "https://antigravity.google";
    changelog = "https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "agy";
    platforms = builtins.attrNames sources.sources;
  };
}
