{
  title = "Oh My Pi";
  tagline = "gateway or own provider · extensions";
  auth = "gateway";
  order = 0;
  releaseNotes = version: "https://github.com/can1357/oh-my-pi/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "ompGateway"; script = builtins.readFile ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "gatewayEnv"; script = import ../../test/guest-script.nix ./tests/check-gateway-env.py; requires = [ "gateway" ]; }
    { name = "ompKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "ompKoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "ompPlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "omp"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
