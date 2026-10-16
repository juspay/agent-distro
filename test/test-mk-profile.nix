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
  # A flake input is a source whose `outPath` is a store path; it is built too.
  asSource = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = { outPath = "${./fixtures/profile}"; };
  };
  referenced = builtins.tryEval (mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = profile // { plugins = [ "github:juspay/skills" ]; };
  }).drvPath;
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
assert forForeign.drvPath == pluginsOnly.drvPath;
pkgs.runCommand "mk-profile" { nativeBuildInputs = [ pkgs.jq ]; } ''
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
  # A directory, a file, a source and the attribute set are the same profile.
  for other in ${asDirectory} ${asFile} ${asSource}; do
    test -f "$other/share/agent-distro/profile.json"
  done
  # A profile with no plugins has an empty `plugins/` and its env.
  test -d ${pluginless}/share/agent-distro/plugins
  test -z "$(ls -A ${pluginless}/share/agent-distro/plugins)"
  test "$(jq -r .env.PLAIN ${pluginless}/share/agent-distro/profile.json)" = 1
  # `bin/` holds the packages' commands, and their other outputs are not here:
  # the tool's own `share/` would be, if the profile linked a whole `lib.getBin`
  # output rather than its `bin/`.
  test "$(ls ${build}/bin)" = profile-tool
  test ! -e ${build}/share/profile-tool-data
  test -d ${build}/share/agent-distro
  touch "$out"
''
