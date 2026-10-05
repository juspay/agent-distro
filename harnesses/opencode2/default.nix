# The OpenCode adapter on the v2 config schema.
args: import ../opencode/default.nix (args // {
  schema = "v2";
  shape = ./gateway-shape.json;
  sessionDefaults = builtins.readFile ./session-defaults.sh;
})
