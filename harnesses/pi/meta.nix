{
  title = "Pi";
  tagline = "OMP's upstream · plugins per home";
  order = 5;
  releaseNotes = version: "https://github.com/earendil-works/pi/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "piKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "piKoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "piPlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "changed" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "pi"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AGENT_DISTRO_SETTINGS = "0"; }
  ];
}
