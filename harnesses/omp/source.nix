# npins records a release pin's url by tag, and upstream re-points release tags
# after publishing them (v19.1.0 named three commits in its first day), which
# turns the pinned hash into a mismatch on the next uncached fetch. Fetch the
# revision npins resolved the tag to instead: the same tree, so the same hash,
# for as long as the pin stands, whatever the tag names later.
{ pkgs }:
let
  sources = builtins.fromJSON (builtins.readFile ./npins/sources.json);
  pin = sources.pins.oh-my-pi;
  inherit (pin.repository) owner repo;
  byRevision = pin // { url = "https://api.github.com/repos/${owner}/${repo}/tarball/${pin.revision}"; };
in
import ../../lib/flake-source.nix {
  inherit pkgs;
  src = (import ./npins { input = sources // { pins = sources.pins // { oh-my-pi = byRevision; }; }; }).oh-my-pi;
}
