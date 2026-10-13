# Where CI publishes the bundles it built, and the index that names them:
# content-addressed for the systems that can run one (a `ca` beside the signed
# `ia`), the signed bundle alone for macOS, where rewriting a Mach-O leaves a
# signature arm64 refuses to exec. `rawBase` is what the updater — and any
# other consumer, kolu among them, which reads it from `lib` rather than
# hardcoding one — fetches `<rev>/<system>/<profile>.json` and
# `latest/<system>/<profile>.json` from.
#
# The workflow pushes to `branch`, and the site states `rawBase` for a reader
# consuming the index by hand, so .github/scripts/check-cache-config.py keeps
# those copies equal to this file — the same way flake.nix's `nixConfig` and
# CI's nix config repeat lib/cache.nix's URL and key.
let
  repo = "juspay/agent-distro";
  branch = "ca-index";
in
{
  inherit repo branch;
  rawBase = "https://raw.githubusercontent.com/${repo}/${branch}";
}
