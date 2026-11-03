# The one binary cache for this distribution's builds. flake.nix's `nixConfig`
# must repeat it literally (flake attributes cannot be computed), so
# .github/scripts/check-cache-config.py keeps the copies equal.
#
# It is odu's cache (`odu cache`): one bucket, read straight from the store it
# lives in (`url` is that store's URL with the bucket as a path), and the server
# signs every path on ingest. `pusher` is how a publisher knows WHICH client
# pushes to it, and WHERE: the store serves static files, so a push goes to
# odu's own `origin` instead. kolu's `publish-closure` action reads the field
# from `binary-cache.json` (the same values, checked equal) and runs that
# client. It is not a substituter setting: no reader of `url`/`publicKey` reads
# it.
{
  url = "https://cache.kolu.dev/kolu-r2";
  publicKey = "kolu-r2-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
  pusher = {
    kind = "odu";
    bucket = "kolu-r2";
    origin = "https://odu-k3s.rooster-blues.ts.net";
  };
}
