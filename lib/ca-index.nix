# Where CI publishes what it built, and the index that names it: the package
# content-addressed for the systems that can run one (a `ca` beside the signed
# `ia`), the signed package alone for macOS, where rewriting a Mach-O leaves a
# signature arm64 refuses to exec. `rawBase` is what the updater — and any
# other consumer, kolu among them, which reads it from `lib` rather than
# hardcoding one — fetches `<rev>/<system>/default.json` from: the one package,
# under the flake attribute the index names it by (src/update/ca-index.ts
# `ATTRIBUTE`).
#
# CI publishes to `branch` through kolu's shared publisher (the
# `publish-closure` action, juspay/kolu#2294), which is handed
# `binary-cache.json` — the declaration this repository checks in, because the
# job that publishes has no Nix until the action installs its own. That file
# names this index and the cache the package goes to, and
# .github/scripts/check-cache-config.py keeps it equal to this file and to
# lib/cache.nix, the way flake.nix's `nixConfig` repeats lib/cache.nix's URL and
# key.
let
  repo = "juspay/agent-distro";
  branch = "ca-index";
in
{
  inherit repo branch;
  rawBase = "https://raw.githubusercontent.com/${repo}/${branch}";
}
