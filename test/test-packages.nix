# A profile's packages are what every harness finds by bare name. Stub
# harnesses report the lookup themselves, so this needs no VM and no network.
{ pkgs, bindLaunchers }:
let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  stub = name: {
    packages.${system}.default =
      pkgs.writeShellScriptBin name "command -v profile-tool" // { version = "0"; };
  };
  tool = pkgs.writeShellScriptBin "profile-tool" "";
  decoy = pkgs.writeShellScriptBin "profile-tool" "";
  profile = { name = "packaged"; description = "Packaged"; plugins = [ ]; gateway = null; };
  mkLaunchers = bindLaunchers {
    oh-my-pi = stub "omp";
    codex-cli = stub "codex";
    claude-code = stub "claude";
    opencode = stub "opencode";
    opencode-v2 = _: (stub "opencode2").packages.${system}.default;
  };
  packaged = mkLaunchers { inherit pkgs; profile = profile // { packages = _: [ tool ]; }; };
  bare = mkLaunchers { inherit pkgs profile; };
in
pkgs.runCommand "packages" { } ''
  for launcher in ${lib.escapeShellArgs (map (h: lib.getExe packaged.${h}) packaged.bundle.commands)}; do
    # Ahead of the user's own PATH, so a launch runs what the build pinned.
    found=$(PATH=${decoy}/bin "$launcher")
    [ "$found" = ${tool}/bin/profile-tool ] || { echo "$launcher found $found" >&2; exit 1; }
  done
  # A profile without packages leaves PATH to the user.
  for launcher in ${lib.escapeShellArgs (map (h: lib.getExe bare.${h}) bare.bundle.commands)}; do
    found=$(PATH=${decoy}/bin "$launcher")
    [ "$found" = ${decoy}/bin/profile-tool ] || { echo "$launcher found $found" >&2; exit 1; }
  done
  touch "$out"
''
