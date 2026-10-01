# Directory names are command names; metadata owns ordering and presentation.
let
  entries = builtins.readDir ../harnesses;
  names = builtins.filter (name: entries.${name} == "directory") (builtins.attrNames entries);
  metadata = builtins.listToAttrs (map
    (name: {
      inherit name;
      value = import (../harnesses + "/${name}/meta.nix");
    })
    names);
  ordered = builtins.sort
    (a: b:
      if metadata.${a}.order == metadata.${b}.order then a < b
      else metadata.${a}.order < metadata.${b}.order)
    names;
in
{ inherit metadata ordered; }
