{
  title = "Claude Code";
  order = 2;
  releaseNotes = version: "https://github.com/anthropics/claude-code/releases/tag/v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "claudeKolu"; script = ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; }
    { name = "claudePlugins"; script = ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" ]; }
    { name = "claudeSpec"; script = ./tests/check-spec.py; requires = [ "spec" ]; packages = [ "recordFixture" ]; }
    { name = "claude"; script = ./tests/check.py; requires = [ ]; packages = [ ]; }
  ];
}
