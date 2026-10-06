# The one definition of where a distribution's `current` lives, so a consumer
# building the shims and the updater, and the updater's own run, can never
# disagree. A different source (flake or profile) must never reuse the
# previous distribution's state.
{ xdgStateHome, flake, profile }:
let
  # `current`, `last-success` and the updated bundles live under this subdir.
  source = builtins.hashString "sha256" (builtins.toJSON { inherit flake profile; });
in
"${xdgStateHome}/agent-distro/${source}"