# One profile, built: `agent-distro.lib.mkProfile { system; profile; hostSystem ? system; }`.
#
# A profile built this way is pinned and offline: nothing of it is fetched or
# compiled at launch, and its store path works anywhere a profile reference
# does — AI_PROFILE, `profiles` in the Home Manager module, a positional
# selector. A profile that is not built is read at launch instead
# (src/profile/resolve.ts).
#
# It holds what src/profile/resolve.ts reads for a built profile:
#
#   share/agent-distro/profile.json          name, description, env, settings
#                                            and `reader`: the runtime tree that
#                                            read the plugins below
#   share/agent-distro/plugins/<index>/root  a symlink to the plugin
#   share/agent-distro/plugins/<index>/description.json
#                                            that reader's output for it
#   bin/                                     the profile's `packages`, `bin/` only
#
# `profile` is a path to a `plugin.json` or to the directory holding one — a
# Nix path, a store path in a string, or the flake input itself, whose
# `outPath` is one — or the profile's fields as an attribute set, for a Nix
# consumer that has no file to point at: `name`, `description`, `plugins`,
# `packages`, `env` and `settings`, exactly as the manifest's extension holds
# them (`packages` a list of nixpkgs attribute paths). A `plugin.json` profile's
# own directory is its first plugin; an attribute set has no directory, so it
# lists its plugins itself. An `agent-distro.nix` is no longer read: finding one
# is an error saying to migrate (src/profile/resolve.ts `migration`).
#
# Its plugins are paths — a flake input's, or a checkout's — or flake references
# (`github:owner/repo?dir=sub`), which are locked here, once: fetched with
# `builtins.fetchTree` as lib/flake-source.nix fetches its sources, and built
# in as the store path they are at that moment, so the built profile follows no
# branch. Locking reads the network, which only an impure evaluation may do
# (`nix build --impure`); a pure one — a flake's own outputs, a Home Manager
# configuration — is refused with that said, and pins the reference as a flake
# input of its own instead, passing that path.
#
# `hostSystem` is the system the profile will be launched on, when it is not
# the one building it (a program that builds profiles for other machines —
# kolu — and ships them there). The profile is then built for `system`: its
# plugins, `env` and `settings` mean the same on any system, and its `reader`
# simply differs from the host's, so a launch there reads the plugins itself —
# PROVIDED its `packages` are empty for `hostSystem`, since `system` cannot
# build those. A profile with packages there is refused, naming it and both
# systems: nothing drops them.
{ nixpkgs, system, profile, hostSystem ? system }:
let
  pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
  inherit (pkgs) lib;
  runtime = import ./runtime.nix pkgs;
  # The path-like `profile` names: a `plugin.json`, or the directory holding
  # one. A flake input is a source whose `outPath` is a store path, and its
  # context rides the path, so the build depends on the input either way.
  at =
    if builtins.isPath profile then profile
    else if builtins.isAttrs profile && (profile ? outPath) then
      /. + builtins.unsafeDiscardStringContext profile.outPath
    else
      /. + builtins.unsafeDiscardStringContext (toString profile);
  # `agent-distro.nix` is gone; a repository that still carries it is told to
  # migrate rather than told it has no profile.
  migration =
    let url = "https://agent-distro.kolu.dev/#profiles";
    in file: "${file}: agent-distro.nix is no longer read — a profile is a plugin.json. Move its fields into extensions.\"asia.nixos.agent-distro\" (see ${url}; schema https://agent-distro.kolu.dev/agent-distro.schema.json)";
  directory = if builtins.baseNameOf (toString at) == "plugin.json" then builtins.dirOf at else at;
  file =
    if builtins.baseNameOf (toString at) == "agent-distro.nix" then throw (migration (toString at))
    else if builtins.pathExists (directory + "/agent-distro.nix") then throw (migration (toString (directory + "/agent-distro.nix")))
    else if builtins.pathExists (directory + "/plugin.json") then directory + "/plugin.json"
    else throw "mkProfile: no plugin.json at ${toString directory} (see https://agent-distro.kolu.dev/#profiles)";
  # The manifest, read here at evaluation rather than by `runtime.readPlugin`:
  # that reader is a derivation, and reading one needs import-from-derivation,
  # which `allow-import-from-derivation = false` refuses — including for a Home
  # Manager `profiles` entry. `readPlugin` still validates the manifest at build
  # time (`described` below, through the profile's own directory as its first
  # plugin).
  manifest = builtins.fromJSON (builtins.readFile file);
  # The members the resolver reads; anything else is an error here too.
  members = [ "plugins" "packages" "env" "settings" ];
  extension = manifest.extensions."asia.nixos.agent-distro" or { };
  unknown = builtins.filter (key: !(builtins.elem key members)) (builtins.attrNames extension);
  # The profile's fields, whichever form `profile` took.
  fields =
    if builtins.isAttrs profile && !(profile ? outPath) then profile
    else if unknown != [ ] then
      throw "mkProfile: a profile's extensions.\"asia.nixos.agent-distro\" has no member `${builtins.head unknown}`"
    else {
      name = manifest.name;
      description = manifest.description or "";
      # The profile's own directory is its first plugin, and is never listed.
      plugins = [ directory ] ++ map
        (entry: if lib.hasPrefix "./" entry then "${directory}/${lib.removePrefix "./" entry}" else entry)
        (extension.plugins or [ ]);
      packages = extension.packages or [ ];
      env = extension.env or { };
      settings = extension.settings or { };
    };
  name = fields.name;
  # A flake reference's directory, locked now: the fetched tree, and its `dir`
  # within it (src/profile/resolve.ts `prefetch` reads a reference at launch
  # the same way). `currentSystem` is what a pure evaluation lacks, and
  # `fetchTree` would refuse the unlocked reference there in words that do not
  # say what to do.
  locked = entry:
    if !(builtins ? currentSystem) then
      throw "mkProfile: profile \"${name}\" names plugin \"${entry}\": a flake reference is locked when the profile is built, which needs an impure evaluation (--impure); in a pure one, pin it as a flake input and pass that path."
    else
      let
        reference = builtins.parseFlakeRef entry;
        tree = builtins.fetchTree (removeAttrs reference [ "dir" ]);
      in
      if reference ? dir then "${tree.outPath}/${reference.dir}" else tree.outPath;
  plugins = map
    (entry: if builtins.isString entry && !(lib.hasPrefix "/" entry) then locked entry else entry)
    (fields.plugins or [ ]);
  # Attribute paths into the nixpkgs the profile is built against, as the
  # launcher evaluates them (src/profile/evaluate-packages.nix).
  packagesFor = pkgs': map
    (attribute:
      let path = lib.splitString "." attribute; in
      if lib.hasAttrByPath path pkgs' then lib.getAttrFromPath path pkgs'
      else throw "mkProfile: profile packages: nixpkgs has no attribute `${attribute}`")
    (fields.packages or [ ]);
  packages =
    if hostSystem == system then packagesFor pkgs
    else if packagesFor (import nixpkgs { system = hostSystem; config.allowUnfree = true; }) != [ ] then
      throw "mkProfile: profile \"${name}\" has packages for ${hostSystem}, which ${system} cannot build"
    else [ ];
  # The directory first, so a profile that names no plugins still has one to
  # read; then one directory per plugin, in order, each with the reader's own
  # output for the plugin and a symlink to it.
  described = pkgs.runCommand "agent-distro-profile-plugins" { } (''mkdir -p "$out/share/agent-distro/plugins"'' + lib.concatStrings (lib.imap0
    (index: plugin:
      let at = "share/agent-distro/plugins/${toString index}"; in ''
        mkdir -p "$out/${at}"
        cp ${runtime.readPlugin plugin} "$out/${at}/description.json"
        ln -s ${plugin} "$out/${at}/root"
      '')
    plugins));
  # Only the packages' `bin/`: those commands are what a launch puts on PATH,
  # and nothing else of a package's output belongs in a profile. Two packages
  # offering one command name is an error, which buildEnv reports.
  bin = pkgs.buildEnv {
    name = "agent-distro-profile-${name}-bin";
    paths = packages;
    pathsToLink = [ "/bin" ];
  };
  json = pkgs.writeTextDir "share/agent-distro/profile.json" (builtins.toJSON {
    inherit name;
    description = fields.description or "";
    env = fields.env or { };
    settings = fields.settings or { };
    # What the descriptions above were written by: a launch uses them only when
    # its own runtime tree has this name (src/profile/resolve.ts `runtimeReader`).
    reader = builtins.baseNameOf (toString runtime.tree);
  });
in
pkgs.symlinkJoin {
  name = "agent-distro-profile-${name}";
  paths = [ described json bin ];
  meta = { description = "agent-distro profile ${name}"; };
}
