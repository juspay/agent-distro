# A profile's launchers: one command per harness, the picker over this profile,
# and the bundle, which joins the commands and that picker as `bin/agent-distro`.
# The bundle describes its profile: `share/agent-distro/profile.json` names it
# and `share/agent-distro/versions` lists its harnesses (src/listing.ts).
#
# A profile here is built in: its plugins are paths at build time, never the
# flake references an `agent-distro.nix` read at launch may also name.
#
# `nixpkgs`, the flake input `pkgs` was imported from, lets the launchers name
# it by a locked reference rather than hold its source
# (lib/nixpkgs-reference.nix); flake.nix and mkFlake pass their own.
{ pkgs, profile, sources ? (name: pkgs: import (../harnesses + "/${name}/source.nix") { inherit pkgs; }), nixpkgs ? null }:
let
  inherit (pkgs) lib;
  nixpkgsReference = import ./nixpkgs-reference.nix pkgs nixpkgs;
  plugins = map
    (plugin:
      if builtins.isString plugin && !(lib.hasPrefix "/" plugin) then
        throw "Profile \"${profile.name}\" names plugin \"${plugin}\": a flake reference is read at launch, not built in; pass a flake input's path instead."
      else plugin)
    profile.plugins;
  gateway = profile.gateway or null;

  # What a plugin's MCP servers name by bare command. They reach every harness
  # the same way, so they go on PATH here, around the adapters, rather than
  # once inside each; they come first, so a launch runs what the build pinned.
  packages = (profile.packages or (_: [ ])) pkgs;
  withPackages = launcher:
    if packages == [ ] then launcher
    else
      pkgs.writeShellApplication {
        inherit (launcher) name;
        runtimeInputs = packages;
        derivationArgs = lib.optionalAttrs (launcher ? version) { inherit (launcher) version; };
        text = ''
          exec ${lib.getExe launcher} "$@"
        '';
      };

  discovery = import ./discover-harnesses.nix;
  harnesses = discovery.ordered;
  commands = lib.genAttrs harnesses (name:
    let adapter = import (../harnesses + "/${name}/default.nix"); in
    withPackages (adapter ({
      inherit pkgs plugins gateway;
      package = sources name pkgs;
      profileName = profile.name;
      # An adapter that takes no `nixpkgs` gets `pkgs`'s source.
    } // lib.optionalAttrs (lib.functionArgs adapter ? nixpkgs) { nixpkgs = nixpkgsReference; })));

  # The profile's own chooser; the bundle carries it so a fetch of the
  # bundle refreshes the picker along with the harnesses.
  picker = pkgs.callPackage ./picker.nix { inherit profile nixpkgsReference; launchers = commands; };

in
commands // {
  bundle = pkgs.symlinkJoin {
    name = "agent-distro-${profile.name}";
    paths = map (name: commands.${name}) harnesses ++ [ picker ];
    postBuild = ''
      mkdir -p "$out/share/agent-distro"
      cp ${pkgs.writeText "agent-distro-versions" (lib.concatMapStrings
        (name: "${name}\t${discovery.metadata.${name}.title}\t${commands.${name}.version}\n")
        harnesses)} "$out/share/agent-distro/versions"
      cp ${pkgs.writeText "agent-distro-profile.json" (builtins.toJSON {
        # The attributes the picker's listing reads, so the two cannot drift.
        inherit (profile) name description;
      })} "$out/share/agent-distro/profile.json"
    '';
    meta.mainProgram = "agent-distro";
    passthru = {
      commands = harnesses;
      # For the Home Manager updater: the Node and tree the launchers use.
      runtime = import ./runtime.nix pkgs;
    };
  };
  inherit picker;
}
