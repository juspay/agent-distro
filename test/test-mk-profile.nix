# `mkProfile` without a VM: what a launch reads of a built profile — the
# `profile.json` naming it and its `reader`, one directory per plugin with that
# reader's description and a symlink to the plugin, and `bin/` from the
# profile's `packages`. A flake reference among the plugins is locked only by
# an impure evaluation, so this one — a flake check, pure — refuses it
# (test/template.sh builds one impurely); the same profile as a directory, a
# file and an attribute set is the one derivation; and one built for a host of
# another system is this system's build without its packages, or refused when
# it has packages for that host.
{ pkgs, agent-distro, mkProfile }:
let
  inherit (pkgs) lib;
  runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
  # A package that is more than `bin/`, so the profile's own `bin/` can be told
  # from its whole output.
  tool = pkgs.runCommand "profile-tool" { } ''
    mkdir -p "$out/bin" "$out/share"
    printf '#!/bin/sh\necho tool\n' > "$out/bin/profile-tool"
    chmod +x "$out/bin/profile-tool"
    printf 'not a command\n' > "$out/share/profile-tool-data"
  '';
  profile = {
    name = "mk-profile-check";
    description = "Built by mkProfile";
    plugins = [ ./fixtures/profile ];
    packages = _: [ tool ];
    env = { MK_PROFILE_CHECK = "1"; };
    settings.omp.modelRoles.default = "litellm/large";
  };
  # A profile may name no plugins at all: `env` and `settings` are the whole of
  # it, and its `plugins/` directory is still there (empty).
  pluginless = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = { name = "pluginless"; description = "No plugins"; env.PLAIN = "1"; };
  };
  build = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = profile; };
  asDirectory = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = ./fixtures/profile; };
  asFile = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = ./fixtures/profile/agent-distro.nix; };
  # A Nix profile file under another name is the Nix form too, as it was before.
  asNamedFile = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = ./fixtures/profile/dev.nix; };
  # A flake input is a source whose `outPath` is a store path; it is built too.
  asSource = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = { outPath = "${./fixtures/profile}"; };
  };
  referenced = builtins.tryEval (mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = profile // { plugins = [ "github:juspay/skills" ]; };
  }).drvPath;
  # A profile that is only an Agent Plugin: the manifest names it and its own
  # directory is its first plugin, with the extension's `plugins`, `packages`,
  # `env` and `settings` (test/fixtures/plugin-profile).
  pluginProfile = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = ./fixtures/plugin-profile;
  };
  # The same profile named by its manifest file rather than its directory.
  asManifestFile = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = ./fixtures/plugin-profile/plugin.json;
  };
  # An extension member the resolver does not read is refused here too.
  badMember = builtins.tryEval (mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = ./fixtures/plugin-profile-bad;
  }).drvPath;
  pluginRoot = ./fixtures/plugin-profile;
  reader = builtins.baseNameOf (toString runtime.tree);
  plugin = ./fixtures/profile;
  # Built here for a host of another system: without packages it is this
  # system's build; with packages for that system it is refused, naming both.
  system = pkgs.stdenv.hostPlatform.system;
  foreign = if system == "x86_64-linux" then "aarch64-darwin" else "x86_64-linux";
  forForeign = mkProfile { inherit system; hostSystem = foreign; profile = removeAttrs profile [ "packages" ]; };
  pluginsOnly = mkProfile { inherit system; profile = removeAttrs profile [ "packages" ]; };
  foreignPackages = builtins.tryEval (mkProfile { inherit system; hostSystem = foreign; inherit profile; }).drvPath;
in
assert !referenced.success;
assert !foreignPackages.success;
assert !badMember.success;
assert forForeign.drvPath == pluginsOnly.drvPath;
# A manifest named by its file, and one by its directory, are the same profile.
assert pluginProfile.drvPath == asManifestFile.drvPath;
# A Nix profile file under another name is the same profile as the directory's.
assert asNamedFile.drvPath == asDirectory.drvPath;
pkgs.runCommand "mk-profile" { nativeBuildInputs = [ pkgs.jq pkgs.nix ]; } ''
  built=${build}
  jq -e --arg reader ${lib.escapeShellArg reader} '
    .name == "mk-profile-check" and .description == "Built by mkProfile"
    and .env.MK_PROFILE_CHECK == "1" and .settings.omp.modelRoles.default == "litellm/large"
    and .reader == $reader' "$built/share/agent-distro/profile.json"
  # The reader names the runtime tree whose output the description is.
  test -f "$built/share/agent-distro/plugins/0/description.json"
  test -L "$built/share/agent-distro/plugins/0/root"
  test "$(readlink -f "$built/share/agent-distro/plugins/0/root")" = ${plugin}
  jq -e --arg root ${lib.escapeShellArg "${plugin}"} '.root == $root and .manifest.name == "fixture-profile"
    and .skills.hello == ["SKILL.md"]' "$built/share/agent-distro/plugins/0/description.json"
  # bin/ is the profile's packages.
  test "$("$built/bin/profile-tool")" = tool
  # A directory, a file, a file under another name, a source and the attribute
  # set are the same profile.
  for other in ${asDirectory} ${asFile} ${asNamedFile} ${asSource}; do
    test -f "$other/share/agent-distro/profile.json"
  done
  # A profile with no plugins has an empty `plugins/` and its env.
  test -d ${pluginless}/share/agent-distro/plugins
  test -z "$(ls -A ${pluginless}/share/agent-distro/plugins)"
  test "$(jq -r .env.PLAIN ${pluginless}/share/agent-distro/profile.json)" = 1
  # A plugin.json profile: the manifest names it, its own directory is its
  # first plugin, the extension adds another and the rest.
  plugin=${pluginProfile}
  jq -e --arg reader ${lib.escapeShellArg reader} '
    .name == "plugin-profile" and .description == "A profile that is only an Agent Plugin"
    and .env.PLUGIN_PROFILE == "yes" and .settings.omp.modelRoles.default == "litellm/small"
    and .reader == $reader' "$plugin/share/agent-distro/profile.json"
  test "$(readlink -f "$plugin/share/agent-distro/plugins/0/root")" = "$(readlink -f ${pluginRoot})"
  test "$(readlink -f "$plugin/share/agent-distro/plugins/1/root")" = "$(readlink -f ${pluginRoot}/extra)"
  jq -e '.manifest.name == "plugin-profile" and .skills.hello == ["SKILL.md"]' \
    "$plugin/share/agent-distro/plugins/0/description.json"
  jq -e '.manifest.name == "plugin-profile-extra" and .skills.extra == ["SKILL.md"]' \
    "$plugin/share/agent-distro/plugins/1/description.json"
  # `bin/` is the extension's `packages`, by nixpkgs attribute path.
  test "$(ls "$plugin/bin")" = hello
  # The manifest file names the same profile, so the same profile.json.
  test -f ${asManifestFile}/share/agent-distro/profile.json
  jq -e '.name == "plugin-profile"' "${asManifestFile}/share/agent-distro/profile.json"
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
  # `bin/` holds the packages' commands, and their other outputs are not here:
  # the tool's own `share/` would be, if the profile linked a whole `lib.getBin`
  # output rather than its `bin/`.
  test "$(ls ${build}/bin)" = profile-tool
  test ! -e ${build}/share/profile-tool-data
  test -d ${build}/share/agent-distro
  touch "$out"
''
