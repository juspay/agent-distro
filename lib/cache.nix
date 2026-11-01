# The one binary cache for this distribution's builds. flake.nix's `nixConfig`
# must repeat it literally (flake attributes cannot be computed), so
# .github/scripts/check-cache-config.py keeps the copies equal.
#
# It is odu's cache (`odu cache`): one bucket, served at its own origin, and the
# server signs every path on ingest. `pusher` is how a publisher knows WHICH
# client pushes to it — kolu's `publish-closure` action reads the field from
# `binary-cache.json` (the same values, checked equal) and runs that client. It
# is not a substituter setting: no reader of `url`/`publicKey` reads it.
{
  url = "https://cache.kolu.dev";
  publicKey = "kolu-1:eAXwD1RPt1BpFjrHfVUO8Ia0bK32WcuIeJcwFWmgj9Y=";
  pusher = {
    kind = "odu";
    bucket = "kolu";
  };
}
