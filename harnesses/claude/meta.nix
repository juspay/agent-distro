{
  title = "Claude Code";
  tagline = "Anthropic login · plugin dirs per session";
  order = 2;
  releaseNotes = version: "https://github.com/anthropics/claude-code/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "claudeKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; }
    { name = "claudePlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; }
    { name = "claudeSpec"; script = import ../../test/guest-script.nix ./tests/check-spec.py; requires = [ "spec" ]; packages = [ "recordFixture" ]; }
    { name = "claude"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; }
  ];
}
