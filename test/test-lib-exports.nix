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
  # The one package the module installs, and the name its updater keys the
  # index by: the registry's default profile.
  default = (import "${agent-distro}/profiles/registry.nix").default;
  # A configuration from one `services.agent-distro` value, the module's own
  # options beside it.
  homeOf = service: (home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      agent-distro.homeManagerModules.default
      {
        home = { username = "testuser"; homeDirectory = "/home/testuser"; stateVersion = "24.05"; };
        xdg.stateHome = "/home/testuser/custom-state";
        services.agent-distro = service;
      }
    ];
  }).config;
  configuration = homeOf { enable = true; };
  svc = configuration.services.agent-distro;
  # The profile bundle the module resolves; a real one, so bundle.* is defined.
  bundle = agent-distro.packages.${pkgs.system}.${default};
  name = builtins.head bundle.commands;
  # The shims the module installs, and one of their commands: what each
  # configuration gives its commands as AI_PROFILE is written there.
  shimsOf = config: lib.findFirst (p: p.name == "agent-distro-shims") null config.home.packages;
  shimOf = config: builtins.readFile "${shimsOf config}/bin/${name}";
  # `profiles` as the module reads them, and `profile` as the one-release
  # spelling of it: a reference is [ it ], a built-in name is none.
  withProfiles = homeOf { enable = true; profiles = [ "github:juspay/skills" ]; };
  withReference = homeOf { enable = true; profile = "github:juspay/skills"; };
  withName = homeOf { enable = true; profile = default; };
  withPath = homeOf { enable = true; profiles = [ ./fixtures/profile ]; };
  builtFixture = agent-distro.lib.mkProfile { system = pkgs.system; profile = ./fixtures/profile; };
  # A path is not the only thing built: a flake input is a source whose
  # `outPath` is a store path, and it is built the same way.
  fixtureSource = { outPath = "${./fixtures/profile}"; };
  withSource = homeOf { enable = true; profiles = [ fixtureSource ]; };
  builtSource = agent-distro.lib.mkProfile { system = pkgs.system; profile = fixtureSource; };
  # A profile that is already built is used as it is: passing the derivation
  # must not build it again (which could not evaluate at all).
  withBuilt = homeOf { enable = true; profiles = [ builtFixture ]; };
  # The line a shim exports an AI_PROFILE with, quoted as mk-shims quotes it.
  exported = value: "export AI_PROFILE=${lib.escapeShellArg value}";

  # The exports, reached by plain import with this test flake's pkgs.
  stateDirectory = import "${agent-distro}/lib/state-directory.nix" {
    inherit (svc) flake;
    # No `profiles`: the module passes the default profile's name, so an
    # install that predates the option keeps the state directory it has.
    profile = default;
    xdgStateHome = configuration.xdg.stateHome;
  };
  shims = import "${agent-distro}/lib/mk-shims.nix" {
    inherit pkgs stateDirectory;
    bundle = bundle;
  };
  updater = import "${agent-distro}/lib/mk-updater.nix" {
    inherit pkgs bundle;
    inherit (svc) flake substituters;
    profile = default;
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
    inherit (svc) flake substituters;
    profile = default;
    inherit stateDirectory;
    history = "${configuration.xdg.stateHome}/agent-distro/history.log";
    nix = lib.getExe pkgs.nix;
  };
  otherPicker = import "${agent-distro}/lib/mk-picker.nix" {
    pkgs = otherPkgs;
    # A real profile and its real mkLaunchers set (not a null stub), so the
    # picker actually forces the launchers it dispatches to.
    profile = agent-distro.profiles.vanilla;
    launchers = agent-distro.lib.mkLaunchers {
      pkgs = otherPkgs;
      profile = agent-distro.profiles.vanilla;
    };
  };
  # A distribution that publishes its own content-addressed bundles: the index
  # it names must reach the config its updater reads.
  ownIndex = "https://example.invalid/own-distro/ca-index";
  ownIndexUpdater = import "${agent-distro}/lib/mk-updater.nix" {
    inherit pkgs bundle;
    inherit (svc) flake substituters;
    profile = default;
    inherit stateDirectory;
    history = "${configuration.xdg.stateHome}/agent-distro/history.log";
    nix = lib.getExe pkgs.nix;
    caIndex = ownIndex;
  };
  ownIndexConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ownIndexUpdater.config));

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
    profile = agent-distro.profiles.${default};
    cache = agent-distro.lib.cache;
  };
  # mkFlake reads an agent-distro.nix by path just as the attribute set it holds.
  mkFlakeFromFile = agent-distro.lib.mkFlake {
    profile = "${agent-distro}/profiles/${default}/agent-distro.nix";
  };
  # A built-in profile names its plugins by path: a flake reference is read at launch.
  referenced = builtins.tryEval (agent-distro.lib.mkLaunchers {
    inherit pkgs;
    profile = agent-distro.profiles.vanilla // { plugins = [ "github:juspay/skills" ]; };
  }).omp.drvPath;
  mkFlakeLibNames = builtins.attrNames mkFlakeOut.lib;
  mkFlakePackageNames = builtins.attrNames mkFlakeOut.packages.${pkgs.system};
  expectedLibNames = [ "caIndex" "cache" "mkFlake" "mkLaunchers" "mkPicker" "mkProfile" "mkShims"
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
    { file = "mk-picker.nix"; required = [ "pkgs" "profile" "launchers" ]; }
    { file = "mk-profile.nix"; required = [ "nixpkgs" "system" "profile" ]; }
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
# The updater keys the index by the bundle's profile, whatever `profiles` names.
assert config.profile == default;
assert config.flake == svc.flake;
assert config.substituters == svc.substituters;
# `profiles`: the option the module reads, and what it gives every command it
# installs as AI_PROFILE. A reference is exported as it was given; a built-in
# name is the one package and no AI_PROFILE at all.
assert configuration.services.agent-distro.profiles == [ ];
assert withProfiles.services.agent-distro.profiles == [ "github:juspay/skills" ];
assert !lib.hasInfix "AI_PROFILE" (shimOf configuration);
assert lib.hasInfix (exported "github:juspay/skills") (shimOf withProfiles);
# The deprecated `profile`: a reference becomes `profiles = [ it ]`; a built-in
# name keeps the package and sets none.
assert lib.hasInfix (exported "github:juspay/skills") (shimOf withReference);
assert !lib.hasInfix "AI_PROFILE" (shimOf withName);
# A path is built by mkProfile, whose store path is the fallback. The path
# carries context, which a regular-expression argument cannot.
assert lib.hasInfix (builtins.unsafeDiscardStringContext (exported builtFixture)) (shimOf withPath);
# A flake input (`inputs.skills`, `flake = false`) is built too, from its
# `outPath`, and the same derivation comes out either way.
assert lib.hasInfix (builtins.unsafeDiscardStringContext (exported builtSource)) (shimOf withSource);
# A `mkProfile` derivation on `profiles` is used as it is: this evaluation is
# the assertion, since building it again cannot evaluate.
assert lib.hasInfix (builtins.unsafeDiscardStringContext (exported builtFixture)) (shimOf withBuilt);
# The index the updater reads comes from lib/ca-index.nix, through the module
# and the library; a distribution's own index reaches the config the same way.
assert config.caIndex == agent-distro.lib.caIndex.rawBase;
assert otherConfig.caIndex == agent-distro.lib.caIndex.rawBase;
assert ownIndexConfig.caIndex == ownIndex;
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
# mkFlake evaluates: exactly the same ten-name lib, packages include the bundle + picker.
assert mkFlakeLibNames == expectedLibNames;
assert lib.elem default mkFlakePackageNames;
assert lib.elem "default" mkFlakePackageNames;
assert builtins.attrNames mkFlakeFromFile.packages.${pkgs.system} == mkFlakePackageNames;
assert !referenced.success;
# A second nixpkgs must build the picker from a real profile and launchers
# (named launchers dispatchers force the whole launcher set).
assert builtins.isString otherPicker.drvPath;
pkgs.runCommand "lib-exports" { nativeBuildInputs = [ pkgs.nix ]; } ''
  export NIX_STATE_DIR="$TMPDIR/nix-state"
  ${builderChecks}
  ${mkFlakeMissingProfile}
  touch "$out"
''
