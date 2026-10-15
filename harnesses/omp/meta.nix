{
  title = "Oh My Pi";
  tagline = "team models or your own · extensions";
  order = 0;
  releaseNotes = version: "https://github.com/can1357/oh-my-pi/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "ompGateway"; script = builtins.readFile ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "ompEnv"; script = import ../../test/guest-script.nix ./tests/check-env.py; requires = [ "gateway" ]; }
    { name = "ompKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "ompKoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "ompPlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "changed" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "omp"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AGENT_DISTRO_SETTINGS = "0"; }
  ];
}
