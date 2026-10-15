# The one definition of where a distribution's `current` lives, so a consumer
# building the shims and the updater, and the updater's own run, can never
# disagree. A different source must never reuse the previous one's state: the
# module passes the flake it updates from and the attribute it builds, not the
# AI_PROFILE, whose profiles do not change what is installed.
{ xdgStateHome, flake, profile }:
let
  # `current`, `last-success` and the updated package live under this subdir.
  source = builtins.hashString "sha256" (builtins.toJSON { inherit flake profile; });
in
"${xdgStateHome}/agent-distro/${source}"