# The Home Manager modules harnesses carry: `harnesses/<name>/home-manager/<feature>.nix`,
# keyed `<name>-<feature>`, the name the flake exports it under. Each file is
# `{ packages }: <module>`, `packages.<system>` being that harness's upstream
# package, and its check, when it has one, is `harnesses/<name>/tests/<feature>.nix`.
let
  discovery = import ./discover-harnesses.nix;
  featuresOf = name:
    let
      directory = ../harnesses + "/${name}/home-manager";
      entries = if builtins.pathExists directory then builtins.readDir directory else { };
      files = builtins.filter
        (file: entries.${file} == "regular" && builtins.match ".+\\.nix" file != null)
        (builtins.attrNames entries);
    in
    map
      (file:
        let feature = builtins.head (builtins.match "(.+)\\.nix" file); in {
          name = "${name}-${feature}";
          value = { harness = name; inherit feature; module = directory + "/${file}"; };
        })
      files;
in
builtins.listToAttrs (builtins.concatMap featuresOf discovery.ordered)
