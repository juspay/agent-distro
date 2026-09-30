# Keep Bun's appended payload intact; invoke Linux binaries through the loader.
{ lib, stdenv, fetchurl, makeBinaryWrapper, ripgrep, sysctl, wayland
, writableTmpDirAsHomeHook }:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);
  system = stdenv.hostPlatform.system;
  targets = {
    x86_64-linux = "linux-x64";
    aarch64-linux = "linux-arm64";
    aarch64-darwin = "darwin-arm64";
  };
  target = targets.${system} or (throw "OpenCode v2: unsupported system ${system}");
in
stdenv.mkDerivation {
  pname = "opencode2";
  inherit (sources) version;
  src = fetchurl {
    url = "https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${sources.version}.tgz";
    hash = sources.hashes.${system};
  };
  sourceRoot = "package";
  nativeBuildInputs = [ makeBinaryWrapper ];
  dontBuild = true;
  dontStrip = true;
  dontPatchELF = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/opencode "$out/libexec/opencode"
    mkdir -p "$out/bin"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # Bun sees the loader as execPath; self-spawn must re-enter this wrapper.
      $CC -shared -fPIC ${./exec-path.c} -ldl \
        -DLOADER='"${stdenv.cc.bintools.dynamicLinker}"' \
        -DWRAPPER='"'"$out/bin/opencode2"'"' -o "$out/libexec/exec-path.so"
    ''}
    makeBinaryWrapper ${if stdenv.hostPlatform.isLinux then stdenv.cc.bintools.dynamicLinker else "$out/libexec/opencode"} "$out/bin/opencode2" \
      ${lib.optionalString stdenv.hostPlatform.isLinux "--add-flags $out/libexec/opencode"} \
      --prefix PATH : ${lib.makeBinPath ([ ripgrep ] ++ lib.optional stdenv.hostPlatform.isDarwin sysctl)} \
      ${lib.optionalString stdenv.hostPlatform.isLinux "--prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ wayland ]}"} \
      ${lib.optionalString stdenv.hostPlatform.isLinux ''--prefix LD_PRELOAD : "$out/libexec/exec-path.so"''} \
      --set OPENCODE_DISABLE_AUTOUPDATE true
    runHook postInstall
  '';
  nativeInstallCheckInputs = [ writableTmpDirAsHomeHook ];
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export OPENCODE_DISABLE_MODELS_FETCH=true
    # Bun's extraction directory must not collide with the unpacked source.
    export TMPDIR=$(mktemp -d)
    actual=$("$out/bin/opencode2" --version)
    printf 'OpenCode version: %s\n' "$actual"
    test "$actual" = "opencode v${sources.version}"
    runHook postInstallCheck
  '';
  meta = {
    description = "OpenCode v2 coding agent, from upstream's prebuilt npm binaries";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "opencode2";
    platforms = builtins.attrNames targets;
  };
}
