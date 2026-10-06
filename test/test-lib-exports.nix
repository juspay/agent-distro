# VM-free: the library functions must evaluate from a plain import of the
# lib/*.nix files with an arbitrary nixpkgs pkgs (kolu's consumption path),
# not only through flake.nix. Asserts that what they produce is exactly what
# the Home Manager module builds from the same inputs: identical shim text,
# the updater config's fields, and the same state directory. Missing required
# arguments fail evaluation (no silent defaults).
{ pkgs, nixpkgs, agent-distro, home-manager }:
let
  inherit (nixpkgs) lib;
  configuration = (home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      agent-distro.homeManagerModules.default
      {
        home = { username = "testuser"; homeDirectory = "/home/testuser"; stateVersion = "24.05"; };
        xdg.stateHome = "/home/testuser/custom-state";
        services.agent-distro = { enable = true; };
      }
    ];
  }).config;
  svc = configuration.services.agent-distro;
  # The profile bundle the module resolves; a real one, so bundle.* is defined.
  bundle = agent-distro.packages.${pkgs.system}.${svc.profile};
  name = builtins.head bundle.commands;

  # The exports, reached by plain import with this test flake's pkgs.
  stateDirectory = import "${agent-distro}/lib/state-directory.nix" {
    inherit (svc) flake profile;
    xdgStateHome = configuration.xdg.stateHome;
  };
  shims = import "${agent-distro}/lib/mk-shims.nix" {
    inherit pkgs stateDirectory;
    bundle = bundle;
  };
  updater = import "${agent-distro}/lib/mk-updater.nix" {
    inherit pkgs bundle;
    inherit (svc) flake profile substituters;
    inherit stateDirectory;
    history = "${configuration.xdg.stateHome}/agent-distro/history.log";
    nix = lib.getExe (if configuration.nix.package == null then pkgs.nix else configuration.nix.package);
  };

  # The module's own values, to prove the exports agree with its behaviour.
  # Locate the shims derivation among the installed packages by name.
  moduleShims = lib.findFirst (p: p.name == "agent-distro-shims") null configuration.home.packages;
  moduleShim = builtins.readFile "${moduleShims}/bin/${name}";
  myShim = builtins.readFile "${shims}/bin/${name}";
  # The module embeds its state directory as a shim line (state=…); the
  # library's function must yield the same directory. Skip the shebang line.
  moduleState = lib.substring 6 100000 (lib.last (lib.filter
    (line: lib.hasPrefix "state=" line) (lib.splitString "\n" moduleShim)));
  # readFile of a store-contained JSON keeps store-string context, which fromJSON
  # rejects; discard it (values are already their literal paths).
  config = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile updater.config));
  schedule = import "${agent-distro}/lib/schedule.nix" lib;

  # The shim is identical text to the module's, so a consumer's edits to it
  # cannot drift: same state line, same exec/fallback logic, same shebang.
  sameShims = builtins.map
    (n: {
      key = n;
      value = builtins.readFile "${shims}/bin/${n}" == builtins.readFile "${moduleShims}/bin/${n}";
    })
    bundle.commands;
  # Required arguments have no defaults (fail fast): `functionArgs` reports a
  # formal parameter as `false` when it has no default, `true` when it does.
  # So the mandatory arguments must be `false`, and the optional schedule ones
  # (`periodSeconds`/`offsetSeconds`) `true`.
  noDefaults =
    builtins.all (arg: (builtins.functionArgs (import "${agent-distro}/lib/mk-shims.nix")).${arg} == false) [ "pkgs" "bundle" "stateDirectory" ]
    && builtins.all (arg: (builtins.functionArgs (import "${agent-distro}/lib/mk-updater.nix")).${arg} == false) [ "flake" "profile" "stateDirectory" "nix" "substituters" ]
    && (builtins.functionArgs (import "${agent-distro}/lib/mk-updater.nix")).periodSeconds == true
    && (builtins.functionArgs (import "${agent-distro}/lib/mk-updater.nix")).offsetSeconds == true
    && builtins.all (arg: (builtins.functionArgs (import "${agent-distro}/lib/state-directory.nix")).${arg} == false) [ "xdgStateHome" "flake" "profile" ];
in
assert noDefaults;
assert stateDirectory == moduleState;
assert myShim == moduleShim;
assert builtins.all (entry: entry.value) sameShims;
assert config.state == moduleState;
assert config.history == "${configuration.xdg.stateHome}/agent-distro/history.log";
assert config.profile == svc.profile;
assert config.flake == svc.flake;
assert config.substituters == svc.substituters;
assert config.periodSeconds == schedule.updatePeriodSeconds;
assert config.offsetSeconds == schedule.updateOffsetSeconds;
# The module derives its ExecStart from the same command list the library
# returns (Home Manager normalises a single command line to a one-element list).
assert lib.escapeShellArgs updater.command ==
  builtins.head configuration.systemd.user.services.agent-distro-update.Service.ExecStart;
pkgs.runCommand "lib-exports" { } ''
  touch "$out"
''