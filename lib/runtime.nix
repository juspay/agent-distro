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
  # The built-in profile every launcher accepts by name.
  vanilla = import ../profiles/vanilla/agent-distro.nix;
  # What the resolver knows at build time (src/profile/resolve.ts): the
  # launcher's own profile, which is `vanilla`'s too when it is not vanilla,
  # and the nixpkgs a profile's `packages` are evaluated against
  # (lib/nixpkgs-reference.nix, from the flake input `nixpkgs`, and its store
  # path, used when present), for this
  # system. lib/mk-launchers.nix builds it once, for every adapter and the picker.
  info = profile: nixpkgs: {
    default = profile.name;
    builtins = map (p: { inherit (p) name description; gateway = p.gateway or null; })
      ([ profile ] ++ pkgs.lib.optional (profile.name != vanilla.name) vanilla);
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
  # Codex adapters translate at launch, so a plugin built into a distribution
  # starts its servers in the launch directory too.
  specPlugin = plugin: pkgs.runCommand "agent-plugin-spec" { } ''
    ${script "plugin/write-spec-plugin.ts"} "$out" ${pkgs.writeText "agent-plugin-spec-args.json" (builtins.toJSON (launcherInputs // { description = "${readPlugin plugin}"; }))}
  '';
  # The shell every launcher runs before its harness: the profile in effect,
  # its gateway and packages, and the plugins of that profile and of
  # AGENT_DISTRO_PLUGINS, as `launched` and `profile_gateway*`. `args` names
  # the adapter (`harness`), the built-in profile's plugins (`profile`, each
  # with its `description`) and the adapter's `info`; the launcher inputs ride
  # along, so no adapter spells them. See src/plugin/launch.ts.
  # Captured before eval, so a failed launch stops the launcher; the variables
  # are declared first, for shellcheck to see what the eval assigns.
  launchPlugins = args: ''
    : "''${launched=}" "''${profile_gateway=}" "''${profile_gateway_url=}" "''${profile_gateway_key_env=}" "''${profile_gateway_key_hint=}"
    launch=$(${script "plugin/launch-cli.mjs"} ${pkgs.writeText "agent-distro-launch.json" (builtins.toJSON (launcherInputs // args))})
    eval "$launch"'';
}
