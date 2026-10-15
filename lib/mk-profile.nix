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
#   bin/                                     the profile's `packages`, `bin/` only
#
# `profile` is a path to an `agent-distro.nix` or to the directory holding one —
# a Nix path, a store path in a string, or the flake input itself, whose
# `outPath` is one — or the attribute set the file holds. Its plugins must be
# paths: a flake input's, or a checkout's. A flake reference is read at launch
# and has no place in a build, so it is refused here — pin it as a flake input
# of your own configuration and pass that path.
{ nixpkgs, system, profile }:
let
  pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
  inherit (pkgs) lib;
  runtime = import ./runtime.nix pkgs;
  # The attribute set the file holds, or the file a path-like `profile` names.
  # A source (a flake input) is one whose `outPath` is a store path; its
  # context rides the path, so the build depends on the input either way.
  attrs =
    if builtins.isAttrs profile && !(profile ? outPath) then profile
    else
      import (
        let
          at =
            if builtins.isPath profile then profile
            else
              /. + builtins.unsafeDiscardStringContext
                (if builtins.isAttrs profile then profile.outPath else toString profile);
        in
        if builtins.pathExists (at + "/agent-distro.nix") then at + "/agent-distro.nix" else at
      );
  # A profile written for an older agent-distro is warned about here, as one
  # read at launch is (src/profile/resolve.ts).
  warned = lib.warnIf (attrs ? gateway)
    "mkProfile: profile ${attrs.name}: `gateway` is no longer read; see https://agent-distro.nixos.asia/#profiles" attrs;
  name = warned.name;
  plugins = map
    (entry:
      if builtins.isString entry && !(lib.hasPrefix "/" entry) then
        throw "mkProfile: profile \"${name}\" names plugin \"${entry}\": a flake reference is read at launch, not built in; pin it as a flake input and pass that path."
      else entry)
    (warned.plugins or [ ]);
  packages = (warned.packages or (_: [ ])) pkgs;
  described = pkgs.runCommand "agent-distro-profile-plugins" { } (''mkdir -p "$out/share/agent-distro/plugins"'' + lib.concatMapStrings
    (index:
      let plugin = builtins.elemAt plugins index; in ''
        mkdir -p "$out/share/agent-distro/plugins/${toString index}"
        cp ${runtime.readPlugin plugin} "$out/share/agent-distro/plugins/${toString index}/description.json"
        ln -s ${plugin} "$out/share/agent-distro/plugins/${toString index}/root"
      '')
    (lib.range 0 (builtins.length plugins - 1)));
  # Only the packages' `bin/`: those commands are what a launch puts on PATH,
  # and nothing else of a package's output belongs in a profile. Two packages
  # offering one command name is an error, which buildEnv reports.
  bin = pkgs.buildEnv {
    name = "agent-distro-profile-${name}-bin";
    paths = packages;
    pathsToLink = [ "/bin" ];
  };
  json = pkgs.writeTextDir "share/agent-distro/profile.json" (builtins.toJSON {
    inherit name;
    description = warned.description or "";
    env = warned.env or { };
    settings = warned.settings or { };
    # What the descriptions above were written by: a launch uses them only when
    # its own runtime tree has this name (src/profile/resolve.ts `runtimeReader`).
    reader = builtins.baseNameOf (toString runtime.tree);
  });
in
pkgs.symlinkJoin {
  name = "agent-distro-profile-${name}";
  paths = [ described json bin ];
  meta = { description = "agent-distro profile ${name}"; };
}
