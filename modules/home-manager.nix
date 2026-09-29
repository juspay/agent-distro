# Keep installed commands usable while independently refreshing their selected distribution.
{ bundles, defaultProfile, defaultFlake ? null }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
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
  updater = pkgs.writeShellScript "agent-distro-update" ''
    set -eu
    ${state}
    ${pkgs.coreutils}/bin/mkdir -p "$state"
    exec ${lib.getExe (if config.nix.package != null then config.nix.package else pkgs.nix)} build \
      ${lib.escapeShellArg "${cfg.flake}#${cfg.profile}"} --refresh --out-link "$state/current"
  '';
  # launchd has no start-limit counter, so bound retries within this invocation.
  launchdUpdater = pkgs.writeShellScript "agent-distro-update-retry" ''
    for attempt in 1 2 3; do
      ${updater} && exit 0
      [ "$attempt" -lt 3 ] || exit 1
      ${pkgs.coreutils}/bin/sleep 300
    done
  '';
in
{
  options.services.agent-distro = {
    enable = lib.mkEnableOption "daily updates of the three coding agents";
    profile = lib.mkOption {
      type = lib.types.str;
      default = defaultProfile;
      description = "Profile bundle to install and update.";
    };
    flake = lib.mkOption ({
      type = lib.types.str;
      description = "Flake reference supplying the profile bundle.";
    } // lib.optionalAttrs (defaultFlake != null) { default = defaultFlake; });
    frequency = lib.mkOption {
      type = lib.types.str;
      default = "daily";
      description = "systemd OnCalendar schedule; macOS supports daily only.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !pkgs.stdenv.isDarwin || cfg.frequency == "daily";
      message = "services.agent-distro.frequency on macOS must be \"daily\".";
    }];
    home.packages = [ shims ];
    systemd.user.services.agent-distro-update = lib.mkIf pkgs.stdenv.isLinux {
      Unit = {
        Description = "Update agent-distro profile";
        StartLimitIntervalSec = "1h";
        StartLimitBurst = 3;
      };
      Service = {
        Type = "oneshot";
        ExecStart = "${updater}";
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
        ProgramArguments = [ "${launchdUpdater}" ];
        StartCalendarInterval = [{ Hour = 12; Minute = 0; }];
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
