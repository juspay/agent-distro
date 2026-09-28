# Validates an Agent Plugin once, for any adapter that needs more than its
# directory. Harness-independent: the output tracks the Agent Plugins spec, not
# any harness's plugin format. A fatal manifest violation fails the build.
{ runCommand, python3 }:
plugin: runCommand "agent-plugin.json" { } ''
  ${python3.interpreter} ${./read-plugin.py} ${plugin} > "$out"
''
