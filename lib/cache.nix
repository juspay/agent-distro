# The one binary cache for this distribution's builds. flake.nix's `nixConfig`
# must repeat it literally (flake attributes cannot be computed), so
# .github/scripts/check-cache-config.py keeps the copies equal.
{
  url = "https://cache.nixos.asia/oss";
  publicKey = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
}
