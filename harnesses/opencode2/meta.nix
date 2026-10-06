{
  title = "OpenCode v2";
  tagline = "v2 preview · private server per launch";
  order = 4;
  releaseNotes = version: "https://github.com/anomalyco/opencode/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "opencode2Gateway"; script = builtins.readFile ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "opencode2Kolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode2KoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode2Plugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode2"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
