# A profile fixture: this directory is both the profile and its plugin, as
# templates/default is. `mkProfile` builds it (test/test-mk-profile.nix), and
# the Home Manager module builds one from a path (test/test-lib-exports.nix).
{
  name = "fixture-profile";
  description = "A profile under test/fixtures";
  plugins = [ ./. ];
  env.FIXTURE = "yes";
}
