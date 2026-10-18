# One profile, built: `agent-distro.lib.mkProfile { system; profile; hostSystem ? system; }`.
#
# A profile built this way is pinned and offline: nothing of it is evaluated,
# fetched or compiled at launch, and its store path works anywhere a profile
# reference does — AI_PROFILE, `profiles` in the Home Manager module, a
# positional selector. A profile that is not built is read at launch instead
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
# `profile` is a path to an `agent-distro.nix` or to the directory holding one —
# a Nix path, a store path in a string, or the flake input itself, whose
# `outPath` is one — or the attribute set the file holds. A directory with no
# `agent-distro.nix` but a `plugin.json` is a profile too: the manifest names
# it and its directory is its first plugin, with
# `extensions."asia.nixos.agent-distro"` adding `plugins`, `packages`, `env`
# and `settings`. Its plugins are paths — a flake input's, or a checkout's — or flake references
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
  # The directory a path-like `profile` names: the file itself or the directory
  # holding it. A flake input is a source whose `outPath` is a store path, and
  # its context rides the path, so the build depends on the input either way.
  directory =
    let
      at =
        if builtins.isPath profile then profile
        else
          /. + builtins.unsafeDiscardStringContext
            (if builtins.isAttrs profile then profile.outPath else toString profile);
    in
    if builtins.elem (builtins.baseNameOf (toString at)) [ "agent-distro.nix" "plugin.json" ]
    then builtins.dirOf at
    else at;
  # An `agent-distro.nix` wins over a `plugin.json`, as it does at launch
  # (src/profile/resolve.ts `findProfile`).
  file =
    if builtins.pathExists (directory + "/agent-distro.nix") then directory + "/agent-distro.nix"
    else if builtins.pathExists (directory + "/plugin.json") then directory + "/plugin.json"
    else null;
  # The manifest of a plugin.json profile, read here at evaluation rather than
  # by `runtime.readPlugin`: that reader is a derivation, and reading one needs
  # import-from-derivation, which `allow-import-from-derivation = false`
  # refuses — including for a Home Manager `profiles` entry. `readPlugin` still
  # validates the same manifest at build time (`described` below).
  manifest =
    if file == null || builtins.baseNameOf (toString file) != "plugin.json" then null
    else builtins.fromJSON (builtins.readFile (directory + "/plugin.json"));
  # The attribute set a plugin.json profile stands for: the manifest's name and
  # description, its directory as the first plugin (and never listed), and the
  # extension's members, with the shapes the resolver validates at launch.
  # `packages` is the Nix form's function, over the attribute paths the
  # extension names.
  extension = if manifest == null then { } else manifest.extensions."asia.nixos.agent-distro" or { };
  # The members the resolver reads; anything else is an error here too.
  members = [ "plugins" "packages" "env" "settings" ];
  unknown = builtins.filter (key: !(builtins.elem key members)) (builtins.attrNames extension);
  pluginProfile =
    if manifest == null then null
    else if unknown != [ ] then
      throw "mkProfile: a plugin.json profile's extensions.\"asia.nixos.agent-distro\" has no member `${builtins.head unknown}`"
    else {
      name = manifest.name;
      description = manifest.description or "";
      plugins = [ directory ] ++ map
        (entry: if lib.hasPrefix "./" entry then "${directory}/${lib.removePrefix "./" entry}" else entry)
        (extension.plugins or [ ]);
      packages = pkgs: map
        (attribute:
          let path = lib.splitString "." attribute; in
          if lib.hasAttrByPath path pkgs then lib.getAttrFromPath path pkgs
          else throw "mkProfile: profile packages: nixpkgs has no attribute `${attribute}`")
        (extension.packages or [ ]);
      env = extension.env or { };
      settings = extension.settings or { };
    };
  # The file's attribute set, or the one `profile` holds itself.
  attrs =
    if builtins.isAttrs profile && !(profile ? outPath) then profile
    else if pluginProfile != null then pluginProfile
    else if file != null then import file
    else throw "mkProfile: no agent-distro.nix or plugin.json at ${toString directory}, and no attribute set";
  # A profile written for an older agent-distro is warned about here, as one
  # read at launch is (src/profile/resolve.ts).
  name = lib.warnIf (attrs ? gateway)
    "mkProfile: profile ${attrs.name}: `gateway` is no longer read; see https://agent-distro.nixos.asia/#profiles"
    attrs.name;
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
    (attrs.plugins or [ ]);
  packagesFor = (attrs.packages or (_: [ ]));
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
    description = attrs.description or "";
    env = attrs.env or { };
    settings = attrs.settings or { };
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
