{
  title = "OpenCode v2";
  order = 4;
  releaseNotes = version: "https://github.com/anomalyco/opencode/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "opencode2Gateway"; script = ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "opencode2Kolu"; script = ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode2Plugins"; script = ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode2"; script = ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
