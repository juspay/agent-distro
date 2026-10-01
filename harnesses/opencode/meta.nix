{
  title = "OpenCode";
  tagline = "v1 · gateway or own provider";
  order = 3;
  releaseNotes = version: "https://github.com/anomalyco/opencode/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "opencodeGateway"; script = builtins.readFile ./tests/check-gateway.py; requires = [ "gateway" ]; }
    { name = "opencodeKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; env.AI_GATEWAY = "0"; }
    { name = "opencodePlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; env.AI_GATEWAY = "0"; }
    { name = "opencode"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; env.AI_GATEWAY = "0"; }
  ];
}
