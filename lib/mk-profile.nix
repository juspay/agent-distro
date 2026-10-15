# One profile, built: `agent-distro.lib.mkProfile { system; profile; }`.
#
# A profile built this way is pinned and offline: nothing of it is evaluated,
# fetched or compiled at launch, and its store path works anywhere a profile
# reference does — AI_PROFILE, `profiles` in the Home Manager module, a
# positional selector. A profile that is not built is read at launch instead
# (src/profile/resolve.ts).
#
# It holds what src/profile/resolve.ts reads for a built profile:
#
#   share/agent-distro/profile.json          name, description, env, settings
#                                            and `reader`: the runtime tree that
#                                            read the plugins below
#   share/agent-distro/plugins/<index>/root  a symlink to the plugin
#   share/agent-distro/plugins/<index>/description.json
#                                            that reader's output for it
#   bin/                                     the profile's `packages`, `lib.getBin`
#
# `profile` is a path to an `agent-distro.nix` or to the directory holding one
# (or the attribute set the file holds). Its plugins must be paths — a flake
# input's, or a checkout's. A flake reference is read at launch and has no
# place in a build, so it is refused here: pin it as a flake input of your own
# configuration and pass that path.
{ nixpkgs, system, profile }:
let
  pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
  inherit (pkgs) lib;
  runtime = import ./runtime.nix pkgs;
  # A path to the file, or to the directory holding one — as a Nix path or a
  # store path in a string; anything else is the attribute set the file holds.
  path = if builtins.isPath profile then profile else /. + profile;
  file =
    if builtins.isAttrs profile then profile
    else if builtins.pathExists (path + "/agent-distro.nix") then path + "/agent-distro.nix"
    else path;
  attrs = if builtins.isAttrs file then file else import file;
  name = attrs.name;
  plugins = map
    (entry:
      if builtins.isString entry && !(lib.hasPrefix "/" entry) then
        throw "mkProfile: profile \"${name}\" names plugin \"${entry}\": a flake reference is read at launch, not built in; pin it as a flake input and pass that path."
      else entry)
    (attrs.plugins or [ ]);
  packages = (attrs.packages or (_: [ ])) pkgs;
  described = pkgs.runCommand "agent-distro-profile-plugins" { } (lib.concatMapStrings
    (index:
      let plugin = builtins.elemAt plugins index; in ''
        mkdir -p "$out/share/agent-distro/plugins/${toString index}"
        cp ${runtime.readPlugin plugin} "$out/share/agent-distro/plugins/${toString index}/description.json"
        ln -s ${plugin} "$out/share/agent-distro/plugins/${toString index}/root"
      '')
    (lib.range 0 (builtins.length plugins - 1)));
  json = pkgs.writeTextDir "share/agent-distro/profile.json" (builtins.toJSON {
    inherit name;
    description = attrs.description or "";
    env = attrs.env or { };
    settings = attrs.settings or { };
    # What the descriptions above were written by: a launch uses them only when
    # its own runtime tree has this name (src/profile/resolve.ts `runtimeReader`).
    reader = builtins.baseNameOf (toString runtime.tree);
  });
in
pkgs.symlinkJoin {
  name = "agent-distro-profile-${name}";
  paths = [ described json ] ++ map lib.getBin packages;
  meta = { description = "agent-distro profile ${name}"; };
}
