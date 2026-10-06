# VM-free: the library functions must evaluate from a plain `import` of the
# lib/*.nix files with an arbitrary nixpkgs, not only through flake.nix/flake
# inputs — kolu's consumption path. Two `pkgs` instances are used: agent-distro's
# own (so the produced shims/config can be compared byte-for-byte against what
# the Home Manager module builds from the same instance) and a second, fresh
# `import pkgs.path { }` with its own config, proving the functions are not tied
# to one specific nixpkgs instance.
#
# This is a wiring guard, not a behavioural test: the module already *calls*
# mk-shims.nix/mk-updater.nix/state-directory.nix, so `myShim == moduleShim`
# cannot drift unless the wiring is wrong. What it additionally does is force
# the pieces the module does not: a missing required argument must fail naming
# that argument (checked below by *calling* each function, not just reading
# `functionArgs`), and mkPicker/mkFlake/lib.schedule must all evaluate.
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
  schedule = import "${agent-distro}/lib/schedule.nix" lib;

  # A *second* nixpkgs instance — a fresh import of pkgs.path with its own
  # config — to prove "arbitrary nixpkgs": the exports must not depend on
  # agent-distro's specific package set or allowUnfree setting.
  otherPkgs = import pkgs.path { system = pkgs.system; config.allowUnfree = false; };
  otherShims = import "${agent-distro}/lib/mk-shims.nix" {
    pkgs = otherPkgs;
    inherit stateDirectory;
    bundle = bundle;
  };
  otherUpdater = import "${agent-distro}/lib/mk-updater.nix" {
    pkgs = otherPkgs;
    inherit bundle;
    inherit (svc) flake profile substituters;
    inherit stateDirectory;
    history = "${configuration.xdg.stateHome}/agent-distro/history.log";
    nix = lib.getExe pkgs.nix;
  };
  otherPicker = import "${agent-distro}/lib/mk-picker.nix" {
    pkgs = otherPkgs;
    # A real profile and its real mkLaunchers set (not a null stub), so the
    # picker actually forces the launchers it dispatches to.
    profiles.vanilla = {
      profile = agent-distro.profiles.vanilla;
      launchers = agent-distro.lib.mkLaunchers {
        pkgs = otherPkgs;
        profile = agent-distro.profiles.vanilla;
      };
    };
    default = "vanilla";
  };

  # The shim is identical text to the module's, so a consumer's edits to it
  # cannot drift: same state line, same exec/fallback logic, same shebang.
  sameShims = builtins.all
    (n: builtins.readFile "${shims}/bin/${n}" == builtins.readFile "${moduleShims}/bin/${n}")
    bundle.commands;

  # The module's own values, to prove the exports agree with its wiring.
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
  otherConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile otherUpdater.config));

  # mkFlake must not only import but *evaluate*: build a distribution from a
  # real profile and force its package names and lib attribute names. This is
  # what would have caught the lib/mk-flake.nix parse regression.
  mkFlakeOut = agent-distro.lib.mkFlake {
    profile = agent-distro.profiles.${svc.profile};
    cache = agent-distro.lib.cache;
  };
  mkFlakeLibNames = builtins.attrNames mkFlakeOut.lib;
  mkFlakePackageNames = builtins.attrNames mkFlakeOut.packages.${pkgs.system};
  expectedLibNames = [ "cache" "mkFlake" "mkLaunchers" "mkPicker" "mkShims"
    "mkUpdater" "schedule" "stateDirectory" ];

  # --- missing-required-argument checks, executed in the builder below ---
  # For each function, call it with each required argument omitted. `builtins.tryEval`
  # cannot catch a missing required argument (Nix raises it when forming the call),
  # so each call runs through nix-instantiate and we grep the error names the arg.
  # Placeholder values (empty sets) are never forced: the missing-arg error fires
  # before the body runs.
  missingChecks = [
    { file = "mk-shims.nix"; required = [ "pkgs" "bundle" "stateDirectory" ]; }
    { file = "mk-updater.nix"; required = [ "pkgs" "bundle" "flake" "profile" "stateDirectory" "history" "nix" "substituters" ]; }
    { file = "state-directory.nix"; required = [ "xdgStateHome" "flake" "profile" ]; }
    { file = "mk-picker.nix"; required = [ "pkgs" "profiles" "default" ]; }
  ];
  # mkFlake's file imports with `{ nixpkgs }` and returns the builder, whose
  # one required argument is `profile` — checked by applying the built builder.
  mkFlakeMissingProfile = ''
    set -e
    if nix-instantiate --eval --expr ${lib.escapeShellArg ''
      (import ${agent-distro}/lib/mk-flake.nix { nixpkgs = { }; })
        (builtins.removeAttrs { profile = { }; } [ "profile" ])
    ''} 2>err; then
      echo "expected missing-argument error for 'profile' (mkFlake), but it evaluated" >&2
      exit 1
    fi
    grep -F "without required argument 'profile'" err >/dev/null || {
      echo "missing-argument error for 'profile' (mkFlake) not found in:" >&2
      cat err >&2
      exit 1
    }
  '';
  builderChecks = lib.concatMapStringsSep "\n" (case:
    lib.concatMapStringsSep "\n" (arg:
      let call = ''
        (import ${agent-distro}/lib/${case.file})
          (builtins.removeAttrs { ${lib.concatMapStringsSep " " (k: "${k} = {};") case.required} } [ "${arg}" ])
      '';
      in ''
        set -e
        if nix-instantiate --eval --expr ${lib.escapeShellArg call} 2>err; then
          echo "expected missing-argument error for '${arg}', but it evaluated" >&2
          exit 1
        fi
        grep -F "without required argument '${arg}'" err >/dev/null || {
          echo "missing-argument error for '${arg}' not found in:" >&2
          cat err >&2
          exit 1
        }
      '')
      case.required)
    missingChecks;
in
assert sameShims;
assert stateDirectory == moduleState;
assert myShim == moduleShim;
assert config.state == moduleState;
assert config.history == "${configuration.xdg.stateHome}/agent-distro/history.log";
assert config.profile == svc.profile;
assert config.flake == svc.flake;
assert config.substituters == svc.substituters;
assert config.periodSeconds == schedule.updatePeriodSeconds;
assert config.offsetSeconds == schedule.updateOffsetSeconds;
# A second nixpkgs must still produce a well-formed updater on the same schedule.
assert config.periodSeconds == otherConfig.periodSeconds;
assert config.offsetSeconds == otherConfig.offsetSeconds;
assert otherUpdater ? program && otherUpdater ? command && otherUpdater ? config;
# A second nixpkgs must produce structurally correct shims: same state dir.
assert otherShims.passthru.stateDirectory == stateDirectory;
# The module derives its ExecStart from the same command list the library
# returns (Home Manager normalises a single command line to a one-element list).
assert lib.escapeShellArgs updater.command ==
  builtins.head configuration.systemd.user.services.agent-distro-update.Service.ExecStart;
# mkFlake evaluates: exactly the same eight-name lib, packages include the bundle + picker.
assert mkFlakeLibNames == expectedLibNames;
assert lib.elem svc.profile mkFlakePackageNames;
assert lib.elem "default" mkFlakePackageNames;
# A second nixpkgs must build the picker from a real profile and launchers
# (named launchers dispatchers force the whole launcher set).
assert builtins.isString otherPicker.drvPath;
pkgs.runCommand "lib-exports" { nativeBuildInputs = [ pkgs.nix ]; } ''
  export NIX_STATE_DIR="$TMPDIR/nix-state"
  ${builderChecks}
  ${mkFlakeMissingProfile}
  touch "$out"
''
