# The one binary cache for this distribution's builds. flake.nix's `nixConfig`
# must repeat it literally (flake attributes cannot be computed), so
# .github/scripts/check-cache-config.py keeps the copies equal.
#
# THIS CACHE HOLDS THE WHOLE CLOSURE of every path the index (lib/ca-index.nix)
# names, and a fetcher reads no other cache. A host takes the package with
# `nix copy --from <url> <path>`, which stops at the first path this cache
# lacks, so nothing it needs may be left to cache.nixos.org. The publisher
# (kolu's `publish-closure` action, in cache.yml) makes that true: it pushes
# each closure whole and imports every published path from this cache alone,
# into an empty store, before the index names it.
#
# It is odu's cache (`odu cache`): one bucket, read straight from the store it
# lives in (`url` is that store's URL with the bucket as a path), and the server
# signs every path on ingest. `pusher` is how a publisher knows WHICH client
# pushes to it, and nothing more: the cache states WHERE a push goes itself
# (`Odu-Origin` and `Odu-Bucket` in its `nix-cache-info`), so that client reads
# the address out of `url` (juspay/kolu#2344, juspay/odu#150). kolu's
# `publish-closure` action reads the field from `binary-cache.json` (the same
# value, checked equal) and runs that client. It is not a substituter setting:
# no reader of `url`/`publicKey` reads it.
{
  url = "https://cache.kolu.dev/kolu-r2";
  publicKey = "kolu-r2-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
  pusher = {
    kind = "odu";
  };
}
