# Validates an Agent Plugin once, for any adapter that needs more than its
# directory. Harness-independent: the output tracks the Agent Plugins spec, not
# any harness's plugin format. A fatal manifest violation fails the build.
{ pkgs }:
let
  runtime = import ./runtime.nix pkgs;
in
plugin: pkgs.runCommand "agent-plugin.json" { } ''
  ${runtime.script "plugin/read.ts"} ${plugin} > "$out"
''
