{ bundles, defaultProfile, defaultFlake ? null }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
  available = bundles.${pkgs.stdenv.hostPlatform.system};
  bundle = available.${cfg.profile} or (throw
    "Unknown agent-distro profile \"${cfg.profile}\"; valid names: ${lib.concatStringsSep ", " (builtins.attrNames available)}.");
  # Discover commands from the bundle, keeping shims and collision checks together.
  names = bundle.commands;
  state = ''state="''${XDG_STATE_HOME:-$HOME/.local/state}/agent-distro"'';
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
in
{
  options.services.agent-distro = {
    enable = lib.mkEnableOption "daily updates of the three coding agents";
    profile = lib.mkOption { type = lib.types.str; default = defaultProfile; description = "Profile bundle to install and update."; };
    flake = lib.mkOption ({ type = lib.types.str; description = "Flake reference supplying the profile bundle."; }
      // lib.optionalAttrs (defaultFlake != null) { default = defaultFlake; });
    frequency = lib.mkOption { type = lib.types.str; default = "daily"; description = "systemd OnCalendar schedule; macOS supports daily only."; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !pkgs.stdenv.isDarwin || cfg.frequency == "daily";
      message = "services.agent-distro.frequency on macOS must be \"daily\".";
    }];
    home.packages = [ shims ];
    systemd.user.services.agent-distro-update = lib.mkIf pkgs.stdenv.isLinux {
      Unit.Description = "Update agent-distro profile";
      Service = {
        Type = "oneshot";
        ExecStart = "${updater}";
        Environment = [ "XDG_STATE_HOME=${config.xdg.stateHome}" ];
      };
    };
    systemd.user.timers.agent-distro-update = lib.mkIf pkgs.stdenv.isLinux {
      Unit.Description = "Update agent-distro regularly";
      Timer = { OnCalendar = cfg.frequency; Persistent = true; };
      Install.WantedBy = [ "timers.target" ];
    };
    launchd.agents.agent-distro-update = lib.mkIf pkgs.stdenv.isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ "${updater}" ];
        StartCalendarInterval = [{ Hour = 12; Minute = 0; }];
        EnvironmentVariables.XDG_STATE_HOME = config.xdg.stateHome;
      };
    };
    home.activation.agent-distro-collisions = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      (
        # Activation sanitizes PATH, so ask the user's login shell for theirs.
        unset __ETC_PROFILE_SOURCED __NIXOS_SET_ENVIRONMENT_DONE
        userPath=$("''${SHELL:-${pkgs.runtimeShell}}" -l -c '${pkgs.coreutils}/bin/printenv PATH') || userPath=$PATH
        IFS=: read -r -a dirs <<< "$userPath"
        for name in ${lib.escapeShellArgs names}; do
          for dir in "''${dirs[@]}"; do
            candidate="''${dir:-.}/$name"
            [ -x "$candidate" ] && [ ! -d "$candidate" ] || continue
            resolved=$(${pkgs.coreutils}/bin/readlink -f "$candidate") || continue
            case "$candidate" in
              ${config.home.profileDirectory}/bin/*|"$HOME/.nix-profile/bin/"*) continue ;;
            esac
            shim=$(${pkgs.coreutils}/bin/readlink -f "${shims}/bin/$name")
            [ "$resolved" != "$shim" ] || continue
            printf 'warning: agent-distro PATH collision for %s: %s\n' "$name" "$candidate" >&2
            break
          done
        done
      ) || true
    '';
  };
}
