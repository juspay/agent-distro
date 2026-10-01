{
  title = "Oh My Pi";
  order = 0;
  releaseNotes = version: "https://github.com/can1357/oh-my-pi/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "ompGateway"; script = ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "gatewayEnv"; script = ./tests/check-gateway-env.py; requires = [ "gateway" ]; }
    { name = "ompKolu"; script = ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "ompPlugins"; script = ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "omp"; script = ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
