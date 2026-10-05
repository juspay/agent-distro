# Keep installed commands usable while independently refreshing their selected distribution.
{ bundles, defaultProfile, defaultFlake ? null, cache }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro;
  # One hour after the 11:00 UTC cron in .github/workflows/update-flake.yml.
  updateHourUTC = 12;
  defaultFrequency = "*-*-* ${toString updateHourUTC}:00:00 UTC";
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
  # The daemon ignores a non-trusted user's extra-substituters unless the
  # system config already lists the URL and its key, so verify that rather than
  # trust our own --option to take effect. Prints "usable|unusable<TAB>url<TAB>key".
  cacheCheck = pkgs.writeShellScript "agent-distro-cache-check" ''
    set -eu
    source ${../lib/cache-usable.sh}
    # Nix 2.34 reports a boolean; older releases 1. A local (single-user) store
    # has no daemon to distrust us and may omit the field.
    trusted=$(${nix} store info --json 2>/dev/null | ${pkgs.jq}/bin/jq -r 'if .trusted == true or .trusted == 1 or (.trusted == null and .url != "daemon") then 1 else 0 end') || trusted=0
    known=$({ ${nix} config show substituters; ${nix} config show trusted-substituters; } 2>/dev/null | ${pkgs.coreutils}/bin/tr '\n' ' ')
    keys=$(${nix} config show trusted-public-keys 2>/dev/null | ${pkgs.coreutils}/bin/tr '\n' ' ')
    report() {
      if cache_usable "$trusted" "$known" "$keys" "$1" "$2"; then verdict=usable; else verdict=unusable; fi
      printf '%s\t%s\t%s\n' "$verdict" "$1" "$2"
    }
    ${lib.concatStrings (lib.mapAttrsToList (url: key: "report ${lib.escapeShellArg url} ${lib.escapeShellArg key}\n") cfg.substituters)}
  '';
  # Names of the derivations a build of "$1" (options after it) would compile
  # rather than fetch, at most three. Derivations with allowSubstitutes = false
  # (trivial builders such as symlinkJoin and shell wrappers) are always built
  # locally, so only the substitutable ones count as misses.
  wouldCompile = pkgs.writeShellScript "agent-distro-would-compile" ''
    set -eu
    target=$1
    shift
    # A failing dry run is deliberately swallowed: the real build then
    # reports the actual eval or network error.
    drvs=$(${nix} build "$target" "$@" --dry-run 2>&1 | ${pkgs.gnugrep}/bin/grep -E '^ +/nix/store/.*\.drv$' || true)
    [ -n "$drvs" ] || exit 0
    # shellcheck disable=SC2086
    ${nix} derivation show $drvs | ${pkgs.jq}/bin/jq -r '(.derivations // .) | to_entries[] | select(.value.env.allowSubstitutes? != "") | .value.name' | ${pkgs.coreutils}/bin/head -n 3 | ${pkgs.coreutils}/bin/paste -sd, -
  '';
  updater = pkgs.writeShellScript "agent-distro-update" ''
    set -eu
    ${state}
    ${pkgs.coreutils}/bin/mkdir -p "$state"
    # Empty before the first run: readlink -f also resolves paths that do not exist.
    old=""
    if [ -e "$state/current" ] || [ -L "$state/current" ]; then
      old=$(${pkgs.coreutils}/bin/readlink -f "$state/current")
    fi
    history=${lib.escapeShellArg "${config.xdg.stateHome}/agent-distro/history.log"}
    record() {
      ${pkgs.coreutils}/bin/printf '%s %s %s\n' "$(${pkgs.coreutils}/bin/date +%Y-%m-%dT%H:%M:%S%:z)" ${lib.escapeShellArg cfg.profile} "$1" >> "$history"
    }
    # A skipped update is not a failure: exiting 0 avoids the pointless
    # restart loop, and last-success stays untouched so launchd tries again
    # next hour. Repeats of the same reason are logged once.
    skip() {
      ${pkgs.coreutils}/bin/echo "agent-distro: ${cfg.profile} update skipped: $1" >&2
      if [ "$(${pkgs.coreutils}/bin/tail -n 1 "$history" 2>/dev/null | ${pkgs.coreutils}/bin/cut -d' ' -f3-)" != "skipped: $1" ]; then
        record "skipped: $1"
      fi
      exit 0
    }
    urls=()
    keys=()
    unusable=()
    while IFS=$'\t' read -r verdict url key; do
      if [ "$verdict" = usable ]; then
        urls+=("$url")
        keys+=("$key")
      else
        unusable+=("$url")
      fi
    done < <(${cacheCheck})
    if [ "''${#unusable[@]}" -gt 0 ] && [ "''${#urls[@]}" -eq 0 ]; then
      skip "cache ''${unusable[*]} not usable; add it to nix.settings substituters/trusted-public-keys"
    fi
    options=()
    if [ "''${#urls[@]}" -gt 0 ]; then
      options=(--option extra-substituters "''${urls[*]}" --option extra-trusted-public-keys "''${keys[*]}")
    fi
    # Lock once so the dry run and the build see the same revision.
    ref=$(${nix} flake metadata --refresh --json ${lib.escapeShellArg cfg.flake} | ${pkgs.jq}/bin/jq -r .url) || ref=""
    if [ -z "$ref" ]; then
      ${pkgs.coreutils}/bin/echo "agent-distro: ${cfg.profile} update failed (cannot resolve ${cfg.flake})" >&2
      record "failed: cannot resolve flake"
      exit 1
    fi
    target="$ref#${cfg.profile}"
    # Never compile on a cache miss. Derivations with allowSubstitutes = false
    # (trivial builders such as symlinkJoin and shell wrappers) are always
    # built locally, so only the substitutable ones count as misses.
    missing=$(${wouldCompile} "$target" "''${options[@]}")
    if [ -n "$missing" ]; then
      skip "bundle not fully cached yet (would build $missing)"
    fi
    declare -A old_versions=() old_titles=() new_versions=()
    old_names=()
    has_old=false
    # Capture versions before nix build replaces the current out-link.
    if [ -n "$old" ] && [ -f "$old/share/agent-distro/versions" ]; then
      has_old=true
      while IFS=$'\t' read -r name title version; do
        old_names+=("$name")
        old_versions["$name"]=$version
        old_titles["$name"]=$title
      done < "$old/share/agent-distro/versions"
    fi
    status=0
    ${nix} build "$target" "''${options[@]}" --out-link "$state/current" || status=$?
    if [ "$status" -ne 0 ]; then
      ${pkgs.coreutils}/bin/echo "agent-distro: ${cfg.profile} update failed (exit $status)" >&2
      record "failed: nix build exit $status"
      exit "$status"
    fi
    new=$(${pkgs.coreutils}/bin/readlink -f "$state/current")
    ${pkgs.coreutils}/bin/date -u +%s > "$state/last-success.tmp"
    ${pkgs.coreutils}/bin/mv "$state/last-success.tmp" "$state/last-success"
    if [ "$new" = "$old" ]; then
      ${pkgs.coreutils}/bin/echo "agent-distro: ${cfg.profile} unchanged ($new)"
    else
      changes=""
      add_change() {
        changes+="''${changes:+, }$1"
      }
      if [ -f "$new/share/agent-distro/versions" ]; then
        while IFS=$'\t' read -r name title version; do
          new_versions["$name"]=$version
          if [ "$has_old" = false ]; then
            add_change "$title $version"
          elif [ -z "''${old_versions[$name]+present}" ]; then
            add_change "$title added $version"
          elif [ "''${old_versions[$name]}" != "$version" ]; then
            add_change "$title ''${old_versions[$name]} → $version"
          fi
        done < "$new/share/agent-distro/versions"
        for name in "''${old_names[@]}"; do
          if [ -z "''${new_versions[$name]+present}" ]; then
            add_change "''${old_titles[$name]} removed"
          fi
        done
      else
        changes="versions not recorded by this bundle"
      fi
      record "updated: ''${changes:-no harness version changed}"
      ${pkgs.coreutils}/bin/echo "agent-distro: ${cfg.profile} updated ''${old:-nothing} -> $new"
    fi
  '';
  # launchd has no start-limit counter, so bound retries within this invocation.
  launchdUpdater = pkgs.writeShellScript "agent-distro-update-retry" ''
    set -eu
    ${state}
    source ${../lib/update-due.sh}
    stamp=$(${pkgs.coreutils}/bin/cat "$state/last-success" 2>/dev/null) || stamp=""
    update_due "$(${pkgs.coreutils}/bin/date -u +%s)" "$stamp" ${toString updateHourUTC} || exit 0
    for attempt in 1 2 3; do
      ${updater} && exit 0
      [ "$attempt" -lt 3 ] || exit 1
      ${pkgs.coreutils}/bin/echo "agent-distro: attempt $attempt of 3 failed; retrying in 5 minutes" >&2
      ${pkgs.coreutils}/bin/sleep 300
    done
  '';
in
{
  options.services.agent-distro = {
    enable = lib.mkEnableOption "daily updates of every harness";
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
      (
        ${cacheCheck} | while IFS=$'\t' read -r verdict url _; do
          [ "$verdict" = unusable ] || continue
          printf 'warning: agent-distro cannot use cache %s; updates are skipped rather than built from source. Add it to nix.settings substituters and trusted-public-keys.\n' "$url" >&2
        done
      ) || true
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
