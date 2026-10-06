# The runtime TypeScript tree (src/), run by Node's native type stripping: no
# package.json, bundler or tsc. Its one dependency, `yaml`, is an npm tarball
# pinned in lib/npins and linked as node_modules/yaml beside src/: ES modules
# resolve bare specifiers by walking up node_modules directories (NODE_PATH is
# CommonJS-only), so the copy, not a symlink to the source, is what runs.
pkgs:
let
  node = "${(import ./harness-pkgs.nix pkgs).nodejs-slim_24}/bin/node";
  tree = pkgs.runCommand "agent-distro-runtime" { } ''
    mkdir -p "$out/node_modules"
    cp -r ${../src} "$out/src"
    ln -s ${(import ./npins).yaml} "$out/node_modules/yaml"
  '';
in
{
  inherit node tree;
  # The command line that runs one module, e.g. `script "plugin/read.ts"`.
  script = module: "${node} ${tree}/src/${module}";
}
