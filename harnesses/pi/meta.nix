{
  title = "Pi";
  order = 5;
  releaseNotes = version: "https://github.com/earendil-works/pi/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "piGateway"; script = ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "piKolu"; script = ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "piPlugins"; script = ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "pi"; script = ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
