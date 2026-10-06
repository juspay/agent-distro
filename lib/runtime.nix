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
in
{
  inherit node tree script;
  # One Agent Plugin, validated once into a harness-independent description
  # for any adapter that needs more than its directory. A fatal manifest
  # violation fails the build.
  readPlugin = plugin: pkgs.runCommand "agent-plugin.json" { } ''
    ${script "plugin/read.ts"} ${plugin} > "$out"
  '';
  # The command a launcher runs, only when AGENT_DISTRO_PLUGINS is set, to
  # bring the plugins named there into this launch. `args` names the adapter
  # (`harness`) and the profile's plugins (`profile`, each with its
  # `description`); see src/plugin/launch.ts. Node's compile cache keeps the
  # type-stripped modules, so a launch whose plugins are all translated
  # already costs little more than starting Node.
  launchPlugins = args:
    "NODE_COMPILE_CACHE=\"\${XDG_CACHE_HOME:-\${HOME:-}/.cache}/agent-distro/node-compile-cache\" "
    + "${script "plugin/launch.ts"} ${pkgs.writeText "agent-distro-launch.json" (builtins.toJSON args)}";
}
