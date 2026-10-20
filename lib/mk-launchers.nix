# The agent-distro package: one command per harness, the picker over them, and
# `bin/agent-distro` as the picker. `share/agent-distro/versions` lists the
# harnesses it carries and their versions (src/listing.ts).
#
# No profile is part of the build. A profile is a `plugin.json` read when a
# harness starts, or one built into its own store path
# by lib/mk-profile.nix; a launch composes them (src/profile/resolve.ts). What a
# launcher knows of the build is the nixpkgs its profiles' `packages` are
# evaluated against, and the picker's menu.
#
# `nixpkgs`, the flake input `pkgs` was imported from, lets the launch
# arguments name it by a locked reference rather than hold its source
# (lib/nixpkgs-reference.nix); flake.nix passes its own. Every recipe gets that
# `Info` already built — as `launchPlugins`, seeded with its own `harness` and
# its `name` — so no adapter spells either, and no adapter sees nixpkgs.
{ pkgs, sources ? (name: pkgs: import (../harnesses + "/${name}/source.nix") { inherit pkgs; }), nixpkgs ? null }:
let
  inherit (pkgs) lib;
  discovery = import ./discover-harnesses.nix;
  harnesses = discovery.ordered;
  runtime = import ./runtime.nix pkgs;
  info = runtime.info nixpkgs;
  commands = lib.genAttrs harnesses (name: import (../harnesses + "/${name}/default.nix") {
    inherit pkgs name;
    package = sources name pkgs;
    launchPlugins = args: runtime.launchPlugins (info // { harness = name; name = name; } // args);
  });
  # What the package carries: one line per harness, in menu order. The picker's
  # menu (lib/picker.nix), the launchers beside it and this file are one list,
  # so the three cannot drift.
  versions = pkgs.writeText "agent-distro-versions" (lib.concatMapStrings
    (name: "${name}\t${discovery.metadata.${name}.title}\t${commands.${name}.version}\n")
    harnesses);
  # The package carries its picker, so a fetch of the package refreshes the
  # picker along with the harnesses.
  picker = pkgs.callPackage ./picker.nix { launchers = commands; inherit nixpkgs; };
in
commands // {
  package = pkgs.symlinkJoin {
    name = "agent-distro";
    paths = map (name: commands.${name}) harnesses ++ [ picker ];
    postBuild = ''
      mkdir -p "$out/share/agent-distro"
      cp ${versions} "$out/share/agent-distro/versions"
    '';
    meta.mainProgram = "agent-distro";
    passthru = {
      # The harness names its `bin/` holds, in menu order.
      commands = harnesses;
      # For the Home Manager updater: the Node and tree the launchers use.
      runtime = import ./runtime.nix pkgs;
      # What the picker resolves a profile with, which a launch's packages are
      # evaluated against (src/profile/resolve.ts `Info`).
      inherit (picker.passthru) infoFile;
    };
  };
  inherit picker;
}
