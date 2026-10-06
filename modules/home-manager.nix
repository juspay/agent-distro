# The Home Manager module: the first consumer of the agent-distro library.
# Shims, the updater and the state directory are built by lib/ so any Nix
# consumer can run the same update machinery; only the OS glue (systemd,
# launchd, activation) belongs to Home Manager.
{ bundles, defaultProfile, defaultFlake ? null, cache }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
  available = bundles.${pkgs.stdenv.hostPlatform.system};
  bundle = available.${cfg.profile} or (throw
    "Unknown agent-distro profile \"${cfg.profile}\"; valid names: ${lib.concatStringsSep ", " (builtins.attrNames available)}.");
  schedule = import ../lib/schedule.nix lib;
  stateDirectory = import ../lib/state-directory.nix {
    inherit (cfg) flake profile;
    xdgStateHome = config.xdg.stateHome;
  };
  shims = import ../lib/mk-shims.nix { inherit pkgs bundle stateDirectory; };
  nix = lib.getExe (if config.nix.package != null then config.nix.package else pkgs.nix);
  updater = import ../lib/mk-updater.nix {
    inherit pkgs bundle nix;
    history = "${config.xdg.stateHome}/agent-distro/history.log";
    inherit stateDirectory;
    inherit (cfg) flake profile substituters;
  };
  # Discover commands from the bundle, keeping shims and collision checks together.
  names = bundle.commands;
  state = "state=${lib.escapeShellArg stateDirectory}";
  # The updater command escaped for systemd/activation: bare `command` list.
  updaterCommand = lib.escapeShellArgs updater.command;
in
{
  options.services.agent-distro = {
    enable = lib.mkEnableOption "scheduled updates of every harness";
    profile = lib.mkOption {
      type = lib.types.str;
      default = defaultProfile;
      description = "Profile bundle to install and update.";
    };
    flake = lib.mkOption ({
      type = lib.types.str;
      description = "Flake reference supplying the profile bundle.";
    } // lib.optionalAttrs (defaultFlake != null) { default = defaultFlake; });
    substituters = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { ${cache.url} = cache.publicKey; };
      description = ''
        Binary caches (URL to public key) the updater passes to nix. Only
        effective where the user is trusted or the system config already lists
        them; otherwise the update is skipped, never compiled. {} adds none,
        and updates still never compile, so only a bundle fully available from
        the caches your system already uses will install.
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
        # Superseded out-links must stop rooting bundles the shims no longer use.
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
            printf 'warning: agent-distro PATH collision for %s: %s; bare %s runs %s\n' "$name" "$collision" "$name" "$winner" >&2
          fi
        done
      ) || true
    '';
  };
}
