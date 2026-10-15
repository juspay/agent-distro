# The one package lib/mk-launchers.nix builds: what its `bin/` holds — one
# command per discovered harness and `agent-distro`, and nothing else — and
# `share/agent-distro/versions`, the list the picker and `--list` are built
# from (lib/picker.nix). Stub harnesses, so this needs no VM and no network.
#
# A profile's `packages` reach PATH at launch now, not through a build-time
# wrapper: check-profile.ts ("packages come from the binary cache or the launch
# stops naming them") covers that, and test-profiles.nix covers it in a VM.
{ pkgs, mkLaunchers }:
let
  inherit (pkgs) lib;
  sources = name: pkgs: pkgs.writeShellScriptBin name "" // { version = "0"; };
  launchers = mkLaunchers { inherit pkgs sources; };
  discovery = import ../lib/discover-harnesses.nix;
  inherit (launchers) package;
  expectedVersions = pkgs.writeText "expected-versions" (lib.concatMapStrings
    (name: "${name}\t${discovery.metadata.${name}.title}\t${launchers.${name}.version}\n") discovery.ordered);
  expectedCommands = pkgs.writeText "expected-commands"
    (lib.concatMapStrings (name: "${name}\n") (lib.sort (a: b: a < b) (discovery.ordered ++ [ "agent-distro" ])));
in
assert package.commands == discovery.ordered;
pkgs.runCommand "packages" { } ''
  # One command per harness, the picker as `agent-distro`, and nothing else.
  ls ${package}/bin | sort > commands
  cmp ${expectedCommands} commands
  cmp ${expectedVersions} ${package}/share/agent-distro/versions
  # The picker is what `agent-distro` runs, and every harness command is a
  # launcher of this package.
  grep -q 'picker/choose.ts' ${package}/bin/agent-distro
  touch "$out"
''
