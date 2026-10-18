# `mkProfile` without a VM: what a launch reads of a built profile — the
# `profile.json` naming it and its `reader`, one directory per plugin with that
# reader's description and a symlink to the plugin, and `bin/` from the
# profile's `packages`. A profile is a `plugin.json`, given as a directory, the
# file itself or a flake input; an `agent-distro.nix`, as a file or beside a
# manifest, is refused, telling the repository to migrate; a flake-reference
# plugin is locked only impurely, so this one — a flake check, pure — refuses it
# (test/template.sh builds one impurely); and one built for a host of another
# system is this system's build without its packages, or refused when it has
# packages for that host.
{ pkgs, agent-distro, mkProfile }:
let
  inherit (pkgs) lib;
  runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
  system = pkgs.stdenv.hostPlatform.system;
  # A profile whose extension names another plugin and a package
  # (test/fixtures/plugin-profile).
  build = mkProfile { inherit system; profile = ./fixtures/plugin-profile; };
  # A profile with no extension at all: the plugin alone is the whole of it.
  plain = mkProfile { inherit system; profile = ./fixtures/plugin-profile-plain; };
  # A manifest as a directory, as the file itself, and as a flake input (a
  # source whose `outPath` is a store path): the one derivation.
  asDirectory = mkProfile { inherit system; profile = ./fixtures/profile; };
  asFile = mkProfile { inherit system; profile = ./fixtures/profile/plugin.json; };
  asSource = mkProfile { inherit system; profile = { outPath = "${./fixtures/profile}"; }; };
  # A flake-reference plugin cannot be locked in a pure evaluation.
  referenced = builtins.tryEval (mkProfile { inherit system; profile = ./fixtures/plugin-profile-flake; }).drvPath;
  # An extension member no launch reads is refused here too.
  badMember = builtins.tryEval (mkProfile { inherit system; profile = ./fixtures/plugin-profile-bad; }).drvPath;
  # `agent-distro.nix` is not a profile: the file, and a directory carrying one
  # beside its manifest, are both refused, telling it to migrate.
  legacyFile = builtins.tryEval (mkProfile { inherit system; profile = ./fixtures/legacy/agent-distro.nix; }).drvPath;
  legacyDirectory = builtins.tryEval (mkProfile { inherit system; profile = ./fixtures/plugin-profile-legacy; }).drvPath;
  reader = builtins.baseNameOf (toString runtime.tree);
  fixture = ./fixtures/profile;
  # Built here for a host of another system: without packages it is this
  # system's build; with packages for that system it is refused, naming both.
  foreign = if system == "x86_64-linux" then "aarch64-darwin" else "x86_64-linux";
  forForeign = mkProfile { inherit system; hostSystem = foreign; profile = ./fixtures/plugin-profile-plain; };
  pluginsOnly = mkProfile { inherit system; profile = ./fixtures/plugin-profile-plain; };
  foreignPackages = builtins.tryEval (mkProfile { inherit system; hostSystem = foreign; profile = ./fixtures/plugin-profile; }).drvPath;
in
assert !referenced.success;
assert !badMember.success;
assert !legacyFile.success;
assert !legacyDirectory.success;
assert !foreignPackages.success;
assert forForeign.drvPath == pluginsOnly.drvPath;
# A manifest named by its file, and one by its directory, are the same profile.
assert asDirectory.drvPath == asFile.drvPath;
pkgs.runCommand "mk-profile" { nativeBuildInputs = [ pkgs.jq pkgs.nix ]; } ''
  built=${build}
  jq -e --arg reader ${lib.escapeShellArg reader} '
    .name == "plugin-profile" and .description == "A profile that is only an Agent Plugin"
    and .env.PLUGIN_PROFILE == "yes" and .settings.omp.modelRoles.default == "litellm/small"
    and .reader == $reader' "$built/share/agent-distro/profile.json"
  # The reader names the runtime tree whose output the description is.
  test -f "$built/share/agent-distro/plugins/0/description.json"
  test -L "$built/share/agent-distro/plugins/0/root"
  test "$(readlink -f "$built/share/agent-distro/plugins/0/root")" = "$(readlink -f ${./fixtures/plugin-profile})"
  jq -e '.manifest.name == "plugin-profile" and .skills.hello == ["SKILL.md"]' \
    "$built/share/agent-distro/plugins/0/description.json"
  test "$(readlink -f "$built/share/agent-distro/plugins/1/root")" = "$(readlink -f ${./fixtures/plugin-profile}/extra)"
  jq -e '.manifest.name == "plugin-profile-extra" and .skills.extra == ["SKILL.md"]' \
    "$built/share/agent-distro/plugins/1/description.json"
  # bin/ is the profile's packages, and their other outputs are not here: only
  # the packages' `bin/` is linked.
  test "$(ls "$built/bin")" = hello
  test "$("$built/bin/hello")" = "Hello, world!"
  test "$(ls "$built/share")" = agent-distro
  # A directory, a file and a source are the same profile.
  for other in ${asDirectory} ${asFile} ${asSource}; do
    test -f "$other/share/agent-distro/profile.json"
  done
  # A profile with no extension is the plugin alone: its own directory is its
  # only plugin, and it has no env or settings.
  test -f ${plain}/share/agent-distro/plugins/0/description.json
  test ! -e ${plain}/share/agent-distro/plugins/1
  test "$(jq -c .env ${plain}/share/agent-distro/profile.json)" = '{}'
  # An attribute nixpkgs does not have: the launcher's own expression
  # (src/profile/evaluate-packages.nix) is what says so, in its own words.
  export NIX_STATE_DIR="$TMPDIR/nix-state"
  if nix-instantiate --eval --strict --expr 'import ${agent-distro}/src/profile/evaluate-packages.nix {
      attributes = [ "nope" ];
      nixpkgs = ${pkgs.path};
      system = "${pkgs.stdenv.hostPlatform.system}";
    }' 2>err; then
    echo "evaluate-packages.nix: expected an error for an unknown attribute" >&2
    exit 1
  fi
  grep -F 'nixpkgs has no attribute `nope`' err >/dev/null || { cat err >&2; exit 1; }
  touch "$out"
''
