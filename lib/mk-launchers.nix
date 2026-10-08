# A profile's launchers: one command per harness, the picker over this profile,
# and the bundle, which joins the commands and that picker as `bin/agent-distro`.
{ pkgs, profile, sources ? (name: pkgs: import (../harnesses + "/${name}/source.nix") { inherit pkgs; }) }:
let
  inherit (pkgs) lib;
  inherit (profile) plugins;
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
  commands = lib.genAttrs harnesses (name: withPackages (import (../harnesses + "/${name}/default.nix") {
    inherit pkgs plugins gateway;
    package = sources name pkgs;
    profileName = profile.name;
  }));

  # The profile's own chooser, defaulting to it; the bundle carries it so a
  # fetch of the bundle refreshes the picker along with the harnesses.
  picker = pkgs.callPackage ./picker.nix {
    default = profile.name;
    profiles.${profile.name} = { inherit profile; launchers = commands; };
  };

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
    '';
    passthru = {
      commands = harnesses;
      # For the Home Manager updater: the Node and tree the launchers use.
      runtime = import ./runtime.nix pkgs;
    };
  };
  inherit picker;
}
