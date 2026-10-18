# The fixture profile under another name, for `mkProfile`: any regular file
# that is not a `plugin.json` is the Nix form.
{
  name = "fixture-profile";
  description = "A profile under test/fixtures";
  plugins = [ ./. ];
  env.FIXTURE = "yes";
}
