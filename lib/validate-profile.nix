# Protect the exporters' package namespaces from profile-name collisions.
profile:
let
  reserved = [ "default" ] ++ (import ./discover-harnesses.nix).ordered;
in
if builtins.elem profile.name reserved then
  throw "Profile \"${profile.name}\" uses a reserved name; reserved names: ${builtins.concatStringsSep ", " reserved}."
else profile
