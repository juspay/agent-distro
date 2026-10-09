# `check-profile`: a profile's `packages` against agent-distro's binary caches,
# for the machine it runs on (src/profile/check-cli.ts). It is the launcher's
# no-compile policy run ahead of time, so a profile repository can run it in CI
# once per platform. `info` is as lib/runtime.nix's: the nixpkgs the launcher
# uses, and this system.
{ lib, pkgs, writeShellApplication, info }:
let
  runtime = import ./runtime.nix pkgs;
  cache = import ./cache.nix;
  # The caches the answer is about, rather than the runner's own configuration:
  # nixpkgs' (where its packages are built) and the distribution's.
  caches = pkgs.writeText "agent-distro-check-caches.json" (builtins.toJSON {
    substituters = [ "https://cache.nixos.org" cache.url ];
    trustedPublicKeys = [ "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" cache.publicKey ];
  });
  infoFile = pkgs.writeText "agent-distro-check-info.json" (builtins.toJSON info);
in
writeShellApplication {
  name = "check-profile";
  text = ''
    exec ${runtime.script "profile/check-cli.ts"} ${infoFile} ${caches} "$@"
  '';
}
