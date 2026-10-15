{
  title = "OpenCode";
  tagline = "private server per launch";
  order = 3;
  releaseNotes = version: "https://github.com/anomalyco/opencode/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "opencodeGateway"; script = builtins.readFile ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "opencodeKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "opencodeKoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "opencodePlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AGENT_DISTRO_SETTINGS = "0"; }
    { name = "opencode"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AGENT_DISTRO_SETTINGS = "0"; }
  ];
}
