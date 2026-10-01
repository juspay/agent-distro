# The only mutation is one new directory: exercise the public discovery paths.
{ pkgs, agent-distro, nixpkgs }:
pkgs.runCommand "harness-discovery" { nativeBuildInputs = [ pkgs.nix ]; } ''
  export XDG_CACHE_HOME="$TMPDIR/cache"
  export NIX_STATE_DIR="$TMPDIR/nix-state"
  export NIX_STORE_DIR="$TMPDIR/store"
  cp -R ${agent-distro} source
  chmod -R u+w source
  mkdir -p source/harnesses/discovery-stub/tests
  cat > source/harnesses/discovery-stub/meta.nix <<'META'
  {
    title = "Discovery Stub";
    order = 999;
    releaseNotes = version: "https://example.invalid/releases/" + version;
    checks = [
      { name = "discoveryStub"; script = ./tests/check.py; }
      { name = "discoveryStubGateway"; script = ./tests/check.py; requires = [ "gateway" ]; }
    ];
  }
  META
  cat > source/harnesses/discovery-stub/source.nix <<'SOURCE'
  { pkgs }: pkgs.writeShellScriptBin "discovery-stub" "echo stub"
  SOURCE
  cat > source/harnesses/discovery-stub/default.nix <<'ADAPTER'
  { pkgs, plugins, gateway, package }: pkgs.writeShellScriptBin "discovery-stub" "exec ''${package}/bin/discovery-stub"
  ADAPTER
  echo 'assert True' > source/harnesses/discovery-stub/tests/check.py
  hash=$(nix-hash --type sha256 --base32 source)
  tar -cf source.tar source
  tar -cf nixpkgs.tar -C ${builtins.dirOf (toString nixpkgs)} ${baseNameOf (toString nixpkgs)}
  nix-instantiate --eval --strict --json --option pure-eval true --option substituters "" --expr "
    let
      root = builtins.fetchTarball { url = \"file://$PWD/source.tar\"; sha256 = \"$hash\"; };
      nixpkgs = builtins.fetchTarball { url = \"file://$PWD/nixpkgs.tar\"; sha256 = \"${nixpkgs.narHash}\"; };
      pkgs = import nixpkgs { system = \"x86_64-linux\"; };
      nixpkgsInput = {
        inherit (pkgs) lib;
        outPath = nixpkgs;
        legacyPackages.x86_64-linux = pkgs;
      };
      distro = (import (root + \"/flake.nix\")).outputs { nixpkgs = nixpkgsInput; };
      profile = { name = \"discovery\"; description = \"Discovery\"; plugins = []; gateway = null; };
      launchers = distro.lib.mkLaunchers { inherit pkgs profile; };
      checks = import (root + \"/test/lib.nix\") { inherit pkgs profile launchers; };
      testOutputs = (import (root + \"/test/flake.nix\")).outputs {
        nixpkgs = nixpkgsInput;
        agent-distro = distro // { outPath = root; };
        home-manager = {};
      };
    in assert builtins.elem \"discovery-stub\" launchers.bundle.commands;
       assert builtins.any (row: row.name == \"discovery-stub\" && row.title == \"Discovery Stub\") launchers.picker.rows;
       assert distro.harnesses.x86_64-linux ? discovery-stub;
       assert (distro.harnesses.x86_64-linux.discovery-stub).name == \"discovery-stub\";
       assert !(builtins.tryEval (distro.lib.mkFlake { profile = profile // { name = \"discovery-stub\"; }; })).success;
       assert checks ? discoveryStub;
       assert !(checks ? discoveryStubGateway);
       assert testOutputs.checks.x86_64-linux ? vanilla-discoveryStub;
       assert testOutputs.checks.x86_64-linux ? juspay-discoveryStubGateway;
       assert !(testOutputs.checks.x86_64-linux ? vanilla-discoveryStubGateway);
       true
  " > result.json
  grep -Fx true result.json
  touch "$out"
''
