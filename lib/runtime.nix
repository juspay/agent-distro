# The runtime TypeScript tree (src/), run by Node's native type stripping: no
# package.json, bundler or tsc. Its one dependency, `yaml`, is an npm tarball
# pinned in lib/npins and linked as node_modules/yaml beside src/: ES modules
# resolve bare specifiers by walking up node_modules directories (NODE_PATH is
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
  tree = pkgs.runCommand "agent-distro-runtime" { } ''
    mkdir -p "$out/node_modules"
    cp -r ${../src} "$out/src"
    ln -s ${yaml} "$out/node_modules/yaml"
  '';
  # The command line that runs one module, e.g. `script "plugin/read.ts"`.
  script = module: "${node} ${tree}/src/${module}";
  # The built-in profile every launcher accepts by name.
  vanilla = import ../profiles/vanilla/agent-distro.nix;
  # What the resolver knows at build time (src/profile/resolve.ts): the
  # launcher's own profile, which is `vanilla`'s too when it is not vanilla,
  # and the nixpkgs a profile's `packages` are evaluated against.
  info = { name, description ? "", gateway }: {
    default = name;
    builtins = [ { inherit name description gateway; } ]
      ++ pkgs.lib.optional (name != vanilla.name) { inherit (vanilla) name description gateway; };
    nixpkgs = "${pkgs.path}";
  };
in
{
  inherit node tree script info;
  # One Agent Plugin, validated once into a harness-independent description
  # for any adapter that needs more than its directory. A fatal manifest
  # violation fails the build.
  readPlugin = plugin: pkgs.runCommand "agent-plugin.json" { } ''
    ${script "plugin/read.ts"} ${plugin} > "$out"
  '';
  # The command every launcher runs before its harness, printing shell to
  # eval: the profile in effect, its gateway and packages, and the plugins of
  # that profile and of AGENT_DISTRO_PLUGINS. `args` names the adapter
  # (`harness`), the built-in profile's plugins (`profile`, each with its
  # `description`), its `gateway` and `profileName`; see src/plugin/launch.ts.
  launchPlugins = { profileName, gateway, ... }@args:
    let
      json = builtins.removeAttrs args [ "profileName" ] // { info = info { name = profileName; inherit gateway; }; };
    in
    "${script "plugin/launch-cli.mjs"} ${pkgs.writeText "agent-distro-launch.json" (builtins.toJSON json)}";
}
