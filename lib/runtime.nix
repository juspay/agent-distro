# The runtime TypeScript tree (src/), run by Node's native type stripping: no
# package.json, bundler or tsc. Its two dependencies, `yaml` and `consola`
# (src/log.ts, which imports only `consola/core`), are npm tarballs pinned in
# lib/npins and linked under node_modules beside src/: ES modules resolve bare
# specifiers by walking up node_modules directories (NODE_PATH is
# CommonJS-only), so the copy, not a symlink to the source, is what runs.
pkgs:
let
  # Node is free, so the caller's package set has the same store path as
  # lib/harness-pkgs.nix's, without instantiating nixpkgs again when the
  # caller's set does not allow unfree packages.
  node = "${pkgs.nodejs-slim_24}/bin/node";
  # Passing pkgs makes npins fetch with pkgs.fetchzip: a fixed-output
  # derivation fetched at build time, so evaluation never needs the registry.
  # Its hash is Nix's of the unpacked tree, not npm's `integrity`.
  yaml = (import ./npins).yaml { inherit pkgs; };
  consola = (import ./npins).consola { inherit pkgs; };
  tree = pkgs.runCommand "agent-distro-runtime" { } ''
    mkdir -p "$out/node_modules"
    cp -r ${../src} "$out/src"
    ln -s ${yaml} "$out/node_modules/yaml"
    ln -s ${consola} "$out/node_modules/consola"
  '';
  # The command line that runs one module, e.g. `script "plugin/read.ts"`.
  script = module: "${node} ${tree}/src/${module}";
  # What the resolver knows at build time (src/profile/resolve.ts `Info`): the
  # nixpkgs a profile's `packages` are evaluated against (lib/nixpkgs-reference.nix,
  # from the flake input `nixpkgs`, and its store path, used when present), for
  # this system. A built profile's `reader` is the tree above, whose name a
  # launch compares its own against (src/profile/resolve.ts).
  info = nixpkgs: {
    nixpkgs = import ./nixpkgs-reference.nix pkgs nixpkgs;
    # Without its context, so the launchers do not hold it.
    nixpkgsPath = builtins.unsafeDiscardStringContext (toString pkgs.path);
    system = pkgs.stdenv.hostPlatform.system;
  };
in
rec {
  inherit node tree script info;
  # One Agent Plugin, validated once into a harness-independent description
  # for any adapter that needs more than its directory. A fatal manifest
  # violation fails the build.
  readPlugin = plugin: pkgs.runCommand "agent-plugin.json" { } ''
    ${script "plugin/read.ts"} ${plugin} > "$out"
  '';
  # The two programs every generated launcher runs through
  # (src/plugin/resources.ts): stated once, since the copies below and every
  # launch need the same pair.
  launcherInputs = { bash = pkgs.runtimeShell; env = "${pkgs.coreutils}/bin/env"; };
  # One plugin materialized as an Agent Plugins directory whose stdio servers
  # run through generated launchers: the build-time half of what the OMP and
  # Codex adapters translate at launch (lib/mk-profile.nix uses it too).
  specPlugin = plugin: pkgs.runCommand "agent-plugin-spec" { } ''
    ${script "plugin/write-spec-plugin.ts"} "$out" ${pkgs.writeText "agent-plugin-spec-args.json" (builtins.toJSON (launcherInputs // { description = "${readPlugin plugin}"; }))}
  '';
  # The shell every launcher runs before its harness: the profiles in effect
  # and their packages, the environment and settings they carry for this
  # harness, and the plugins of those profiles and of AGENT_DISTRO_PLUGINS, as
  # `launched`, `profile_env_*` and `profile_settings`. `args` is what the
  # adapter needs beyond that; `harness` and the build's own `Info`
  # (`runtime.info nixpkgs`) are seeded by lib/mk-launchers.nix, so no adapter
  # spells them. See src/plugin/launch.ts.
  # Captured before eval, so a failed launch stops the launcher; the variables
  # are declared first, for shellcheck to see what the eval assigns.
  launchPlugins = args: ''
    : "''${launched=}" "''${profile_env_secrets=}" "''${profile_settings=}"
    launch=$(${script "plugin/launch-cli.mjs"} ${pkgs.writeText "agent-distro-launch.json" (builtins.toJSON (launcherInputs // args))})
    eval "$launch"'';
}
