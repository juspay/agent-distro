{
  title = "OpenCode";
  order = 3;
  releaseNotes = version: "https://github.com/anomalyco/opencode/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "opencodeGateway"; script = ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "opencodeKolu"; script = ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "opencodePlugins"; script = ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode"; script = ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
