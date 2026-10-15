# The Home Manager module: the first consumer of the agent-distro library.
# Shims, the updater and the state directory are built by lib/ so any Nix
# consumer can run the same update machinery; only the OS glue (systemd,
# launchd, activation) belongs to Home Manager.
{ packages, mkProfile, defaultFlake ? null, cache, caIndex ? import ../lib/ca-index.nix }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
  # The one package, for this system: every harness launcher and the picker.
  package = packages.${pkgs.stdenv.hostPlatform.system};
  # The attribute it is published and updated under (mkUpdater's own default).
  attribute = "default";
  # What `profiles` means: a string is a reference read at launch
  # (src/profile/resolve.ts); a derivation is already a built profile and is
  # used as it is; anything else — a path, a flake input — is built by mkProfile,
  # whose store path is a reference too. One package is installed either way,
  # and `profiles` is what every command it installs exports as AI_PROFILE,
  # whitespace-separated.
  # `profile` was the one-profile spelling of this, and is deprecated: a
  # reference is one entry of `profiles`, and a built-in name — which no
  # package carries any more — is the one package and no AI_PROFILE.
  deprecated =
    if cfg.profile != null && (lib.hasPrefix "/" cfg.profile || lib.hasInfix ":" cfg.profile)
    then [ cfg.profile ] else [ ];
  profiles = cfg.profiles ++ deprecated;
  built = map
    (entry:
      if builtins.isString entry || lib.isDerivation entry
      then entry
      else mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = entry; })
    profiles;
  aiProfile = lib.concatStringsSep " " (map toString built);
  schedule = import ../lib/schedule.nix lib;
  stateDirectory = import ../lib/state-directory.nix {
    inherit (cfg) flake;
    # What the updater builds — `packages.<system>.${attribute}` — not the
    # AI_PROFILE string: a profile's own store path changes whenever its input
    # does, and keying the state by it would prune `current` and `last-success`
    # on every `nix flake update`. The attribute is what this release names the
    # one package by, so an install that predates it — which hashed the old
    # `vanilla` profile name — gets a new state directory once: the update
    # fetches the package again, and `agent-distro-prune` below removes the
    # directory it used to read on the same activation.
    profile = attribute;
    xdgStateHome = config.xdg.stateHome;
  };
  shims = import ../lib/mk-shims.nix {
    inherit pkgs package stateDirectory;
    profile = if aiProfile == "" then null else aiProfile;
  };
  nix = lib.getExe (if config.nix.package != null then config.nix.package else pkgs.nix);
  updater = import ../lib/mk-updater.nix {
    inherit pkgs package nix;
    history = "${config.xdg.stateHome}/agent-distro/history.log";
    inherit stateDirectory;
    inherit (cfg) flake substituters caIndex;
  };
  # Discover commands from the package, keeping shims and collision checks together.
  names = package.commands;
  state = "state=${lib.escapeShellArg stateDirectory}";
  # The updater command escaped for systemd/activation: bare `command` list.
  updaterCommand = lib.escapeShellArgs updater.command;
in
{
  options.services.agent-distro = {
    enable = lib.mkEnableOption "scheduled updates of every harness";
    profiles = lib.mkOption {
      type = lib.types.listOf (lib.types.oneOf [ lib.types.str lib.types.path lib.types.package ]);
      default = [ ];
      example = [ "github:juspay/skills" ];
      description = ''
        The profiles every installed command exports as AI_PROFILE,
        whitespace-separated and composed left to right, later entries winning.
        A string is a profile reference, read when a harness starts: a flake
        reference such as the example, or an absolute path to a repository with
        an agent-distro.nix. Anything else — a path, or a flake input
        (`inputs.skills`, with `flake = false`) — is built by lib.mkProfile and
        read from the store, pinned and offline.

        A repository's own agent-distro.nix composes over them where a harness
        starts inside one, and is the only profile in effect where none is
        listed. The environment's own AI_PROFILE, where it is set, wins over
        this.
      '';
    };
    profile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      # One release of warning, wherever the option is read: the list is what
      # to set.
      apply = value: lib.warnIf (value != null)
        "services.agent-distro.profile is deprecated; set services.agent-distro.profiles instead."
        value;
      description = ''
        Deprecated: use `profiles`. One reference, which is `profiles = [ it ]`.
        A value that is not a reference named the profile a built package
        carried, and there is none now: it is the one package, and no
        AI_PROFILE.
      '';
    };
    flake = lib.mkOption ({
      type = lib.types.str;
      description = "Flake reference supplying the package the updater builds.";
    } // lib.optionalAttrs (defaultFlake != null) { default = defaultFlake; });
    substituters = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { ${cache.url} = cache.publicKey; };
      description = ''
        Binary caches (URL to public key) the updater passes to nix. A daemon
        ignores them for a user it does not trust unless the system config
        already lists them; that user's update takes the published
        content-addressed store path instead (caIndex). Updates never compile,
        so only what your caches or the content-addressed one holds will
        install. {} adds none.
      '';
    };
    caIndex = lib.mkOption {
      type = lib.types.str;
      default = caIndex.rawBase;
      description = ''
        Where the updater reads which content-addressed closure CI published:
        `<caIndex>/<rev>/<system>/default.json`, the revision being the one the
        flake resolves to. The default is agent-distro's index; a distribution
        that publishes its own names its own, and one whose revisions this index
        does not carry leaves the update skipped. An `https://` URL with no
        credentials, query or fragment: the updater fetches nothing else, and
        says so as a warning. Content-addressed closures are Linux-only, and
        built with Nix 2.34.x (2.35 addresses a self-referential path
        differently, and a host on it cannot take them): on macOS the index
        names the signed package, which needs the cache key or a trusted user
        like any signed path.
      '';
    };
    frequency = lib.mkOption {
      type = lib.types.str;
      default = schedule.defaultFrequency;
      description = "systemd OnCalendar schedule; macOS supports only the default UTC schedule.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !pkgs.stdenv.isDarwin || cfg.frequency == schedule.defaultFrequency;
      message = "services.agent-distro.frequency on macOS supports only the default: ${schedule.defaultFrequency}.";
    }];
    home.packages = [ shims ];
    home.activation.agent-distro-state = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      (
        ${state}
        # launchd opens update.log before the updater runs, and creates no directories.
        run ${pkgs.coreutils}/bin/mkdir -p "$state"
      )
    '';
    home.activation.agent-distro-cache = lib.hm.dag.entryAfter [ "writeBoundary" ] (lib.optionalString (cfg.substituters != { }) ''
      ${updaterCommand} --cache-warnings || true
    '');
    home.activation.agent-distro-prune = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      (
        ${state}
        # Superseded out-links must stop rooting what the shims no longer use.
        for previous in ${lib.escapeShellArg "${config.xdg.stateHome}/agent-distro"}/*; do
          [ -d "$previous" ] && [ "$previous" != "$state" ] || continue
          run ${pkgs.coreutils}/bin/rm -rf -- "$previous"
        done
      )
    '';
    systemd.user.services.agent-distro-update = lib.mkIf pkgs.stdenv.isLinux {
      Unit = {
        Description = "Update agent-distro profile";
        StartLimitIntervalSec = "1h";
        StartLimitBurst = 3;
      };
      Service = {
        Type = "oneshot";
        ExecStart = updaterCommand;
        Restart = "on-failure";
        RestartSec = "5min";
      };
    };
    systemd.user.timers.agent-distro-update = lib.mkIf pkgs.stdenv.isLinux {
      Unit.Description = "Update agent-distro regularly";
      Timer = {
        OnCalendar = cfg.frequency;
        Persistent = true;
        RandomizedDelaySec = "15min";
      };
      Install.WantedBy = [ "timers.target" ];
    };
    launchd.agents.agent-distro-update = lib.mkIf pkgs.stdenv.isDarwin {
      enable = true;
      config = {
        # launchd has no start-limit counter: --scheduled checks the UTC
        # boundary and bounds retries itself.
        ProgramArguments = updater.command ++ [ "--scheduled" ];
        StandardOutPath = "${stateDirectory}/update.log";
        StandardErrorPath = "${stateDirectory}/update.log";
        # Hourly wake-ups avoid encoding a UTC boundary in launchd's local time.
        StartCalendarInterval = [{ Minute = 0; }];
      };
    };
    home.activation.agent-distro-collisions = lib.hm.dag.entryAfter [ "linkGeneration" "installPackages" ] ''
      (
        # Activation sanitizes PATH, so ask the user's login shell for theirs.
        unset __ETC_PROFILE_SOURCED __NIXOS_SET_ENVIRONMENT_DONE
        # Shell startup messages stay on stdout; only PATH is sent through fd 3.
        userPath=$("''${SHELL:-${pkgs.runtimeShell}}" -l -c '${pkgs.coreutils}/bin/printenv PATH >&3' 3>&1 1>/dev/null) || userPath=$PATH
        IFS=: read -r -a dirs <<< "$userPath"
        for name in ${lib.escapeShellArgs names}; do
          shim=$(${pkgs.coreutils}/bin/readlink -f "${shims}/bin/$name")
          winner=""
          collision=""
          for dir in "''${dirs[@]}"; do
            candidate="''${dir:-.}/$name"
            [ -x "$candidate" ] && [ ! -d "$candidate" ] || continue
            [ -n "$winner" ] || winner=$candidate
            resolved=$(${pkgs.coreutils}/bin/readlink -f "$candidate") || continue
            [ "$resolved" != "$shim" ] || continue
            [ -n "$collision" ] || collision=$candidate
          done
          if [ -n "$collision" ]; then
            printf 'agent-distro shims: warning: PATH collision for %s: %s; bare %s runs %s\n' "$name" "$collision" "$name" "$winner" >&2
          fi
        done
      ) || true
    '';
  };
}
