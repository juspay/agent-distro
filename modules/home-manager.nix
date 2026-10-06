# Keep installed commands usable while independently refreshing their selected distribution.
{ bundles, defaultProfile, defaultFlake ? null, cache }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
  # Two hours after the 00:00/06:00/12:00/18:00 UTC crons in
  # .github/workflows/update-flake.yml.
  updateHoursUTC = [ "02" "08" "14" "20" ];
  defaultFrequency = "*-*-* ${lib.concatStringsSep "," updateHoursUTC}:00:00 UTC";
  # launchd gates the same schedule as a period/phase pair: one period per
  # daily run, phased onto the first hour.
  updatePeriodSeconds = 86400 / builtins.length updateHoursUTC;
  updateOffsetSeconds = lib.toIntBase10 (builtins.head updateHoursUTC) * 3600;
  available = bundles.${pkgs.stdenv.hostPlatform.system};
  bundle = available.${cfg.profile} or (throw
    "Unknown agent-distro profile \"${cfg.profile}\"; valid names: ${lib.concatStringsSep ", " (builtins.attrNames available)}.");
  # Discover commands from the bundle, keeping shims and collision checks together.
  names = bundle.commands;
  # A different source must never reuse the previous distribution's update.
  source = builtins.hashString "sha256" (builtins.toJSON { inherit (cfg) flake profile; });
  stateDirectory = "${config.xdg.stateHome}/agent-distro/${source}";
  state = "state=${lib.escapeShellArg stateDirectory}";
  shims = pkgs.symlinkJoin {
    name = "agent-distro-shims";
    paths = map
      (name: pkgs.writeShellScriptBin name ''
        ${state}
        if [ -x "$state/current/bin/${name}" ]; then
          exec "$state/current/bin/${name}" "$@"
        fi
        exec ${bundle}/bin/${name} "$@"
      '')
      names;
  };
  nix = lib.getExe (if config.nix.package != null then config.nix.package else pkgs.nix);
  # src/update/update.ts is the updater, cache check and history log; the
  # bundle supplies the Node and runtime tree its own launchers already use.
  inherit (bundle) runtime;
  updateConfig = pkgs.writeText "agent-distro-update.json" (builtins.toJSON {
    inherit (cfg) profile flake substituters;
    inherit nix;
    state = stateDirectory;
    history = "${config.xdg.stateHome}/agent-distro/history.log";
    periodSeconds = updatePeriodSeconds;
    offsetSeconds = updateOffsetSeconds;
  });
  update = [ runtime.node "${runtime.tree}/src/update/update.ts" "${updateConfig}" ];
  updater = lib.escapeShellArgs update;
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
      default = defaultFrequency;
      description = "systemd OnCalendar schedule; macOS supports only the default UTC schedule.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !pkgs.stdenv.isDarwin || cfg.frequency == defaultFrequency;
      message = "services.agent-distro.frequency on macOS supports only the default: ${defaultFrequency}.";
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
      ${updater} --cache-warnings || true
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
        ExecStart = updater;
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
        ProgramArguments = update ++ [ "--scheduled" ];
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
