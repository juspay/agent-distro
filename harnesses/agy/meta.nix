{
  title = "Antigravity CLI";
  tagline = "Google login · plugins per home";
  auth = "google";
  order = 6;
  releaseNotes = _: "https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md";
  checks = [
    { name = "agyKolu"; script = import ../../test/guest-script.nix ./tests/check-kolu.py; requires = [ "kolu" ]; packages = [ "koluFixture" ]; }
    { name = "agyKoluLaunch"; script = import ../../test/guest-script.nix ./tests/check-kolu-launch.py; requires = [ "koluLaunch" ]; packages = [ "koluFixture" ]; }
    { name = "agyPlugins"; script = import ../../test/guest-script.nix ./tests/check-plugins.py; requires = [ "plugins" ]; packages = [ "changed" ]; }
    { name = "agy"; script = import ../../test/guest-script.nix ./tests/check.py; requires = [ ]; packages = [ ]; }
  ];
}
