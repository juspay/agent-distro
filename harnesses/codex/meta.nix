{
  title = "Codex";
  order = 1;
  releaseNotes = version: "https://github.com/openai/codex/releases/tag/rust-v${builtins.head (builtins.split "\\+" version)}";
  checks = [
    { name = "codexCli"; script = import ../../test/guest-script.nix ./tests/check-cli.py; requires = [ ]; packages = [ ]; env.CODEX_SESSION_DEFAULTS = "${./session-defaults.sh}"; }
    { name = "codexKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; }
    { name = "codexPlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "updated" "upstream" ]; }
    { name = "codexStaleMarketplace"; script = import ../../test/guest-script.nix ./tests/check-stale-marketplace.py; requires = [ "plugins" ]; packages = [ "upstream" ]; }
    { name = "codexTerminal"; script = import ../../test/guest-script.nix ./tests/check-terminal.py; requires = [ ]; packages = [ ]; }
    { name = "codex"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; }
  ];
}
