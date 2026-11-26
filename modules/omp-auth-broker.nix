# OMP's auth broker: one machine keeps the logins and refreshes them; the
# others borrow access tokens from it. OMP rotates an OAuth refresh token on
# every use, so a login copied to two machines dies on whichever refreshes
# second — the broker keeps the only copy. Independent of
# `services.agent-distro.enable`: a broker host need not install the harnesses.
{ harnesses }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro.omp.authBroker;
  # Where OMP reads its bearer token, client and server alike: the default
  # profile's config root under $HOME (packages/coding-agent/src/cli/
  # auth-broker-cli.ts `getTokenFilePath`, packages/ai/src/auth-broker/
  # discover.ts `getAuthBrokerTokenFilePath`).
  tokenPath = ".omp/auth-broker.token";
  # `serve` writes a fresh token when the file is missing, which no client
  # would know; so the service never starts without one. The address is read
  # at each start, so a Tailscale address is never written into the unit.
  serve = pkgs.writeShellApplication {
    name = "agent-distro-omp-auth-broker";
    text = ''
      token="$HOME/"${lib.escapeShellArg tokenPath}
      if [ ! -r "$token" ] || [ ! -s "$token" ]; then
        echo "agent-distro-omp-auth-broker: error: no token at $token; set services.agent-distro.omp.authBroker.tokenFile or place it there" >&2
        exit 1
      fi
      ${if cfg.serve.address != null then ''
        address=${lib.escapeShellArg cfg.serve.address}
      '' else ''
        if ! addresses=$(${lib.getExe pkgs.tailscale} ip -4); then
          echo "agent-distro-omp-auth-broker: error: no Tailscale address; is Tailscale up?" >&2
          exit 1
        fi
        address=''${addresses%%$'\n'*}
        if ! [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
          echo "agent-distro-omp-auth-broker: error: no Tailscale IPv4 address; is Tailscale up?" >&2
          exit 1
        fi
      ''}
      exec ${lib.getExe cfg.serve.package} auth-broker serve --bind="$address:${toString cfg.serve.port}"
    '';
  };
in
{
  options.services.agent-distro.omp.authBroker = {
    serve = {
      enable = lib.mkEnableOption ''
        OMP's auth broker on this machine, as a systemd user service. It
        serves the logins in this machine's OMP credential store
        (`~/.omp/agent/agent.db`) to every client holding the token. OMP on
        this machine keeps using that store directly; set `url` only on
        clients'';
      address = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "100.64.0.1";
        description = ''
          The address the broker listens on. `null` (the default) reads this
          machine's Tailscale IPv4 address each time the service starts, and
          the start fails, to be retried every 5 seconds, while Tailscale has
          none. The broker speaks plain HTTP: listen only on a network that is
          already private, such as a tailnet.
        '';
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 8765;
        description = "The port the broker listens on: OMP's own default.";
      };
      package = lib.mkOption {
        type = lib.types.package;
        default = harnesses.${pkgs.stdenv.hostPlatform.system}.omp;
        defaultText = lib.literalExpression "agent-distro.harnesses.\${system}.omp";
        description = ''
          The OMP the broker runs: upstream's own, without agent-distro's
          launcher, which prompts for a profile's secrets and so cannot run
          as a service. It moves when this configuration is rebuilt, not
          with the scheduled updates.
        '';
      };
    };
    url = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://broker-host:8765";
      description = ''
        The broker this machine's OMP takes its logins from, exported as
        `OMP_AUTH_BROKER_URL` to login shells and to systemd user services.
        OMP then ignores the logins in its own credential store, except
        those the broker refuses to serve.
      '';
    };
    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/agenix/omp-auth-broker-token";
      description = ''
        A file holding the broker's bearer token, put there by your secret
        manager (agenix, sops-nix, …), never by Nix: `~/.omp/auth-broker.token`,
        where OMP reads it on the broker and on every client, becomes a
        symlink to it, so the token stays out of the Nix store and out of the
        environment. `null` leaves that file to you.
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !(cfg.serve.enable && cfg.url != null);
          message = "services.agent-distro.omp.authBroker: set serve.enable on the broker and url on its clients, not both on one machine; OMP on the broker reads its own credential store.";
        }
        {
          assertion = cfg.serve.enable -> pkgs.stdenv.hostPlatform.isLinux;
          message = "services.agent-distro.omp.authBroker.serve runs as a systemd user service, so it needs Linux.";
        }
      ];
    }
    (lib.mkIf (cfg.tokenFile != null && (cfg.serve.enable || cfg.url != null)) {
      home.file.${tokenPath}.source = config.lib.file.mkOutOfStoreSymlink cfg.tokenFile;
    })
    (lib.mkIf cfg.serve.enable {
      systemd.user.services.agent-distro-omp-auth-broker = {
        Unit = {
          Description = "OMP auth broker";
          # Waiting for Tailscale or for the token is a failed start, retried
          # until it succeeds.
          StartLimitIntervalSec = 0;
        };
        Service = {
          ExecStart = lib.getExe serve;
          Restart = "on-failure";
          RestartSec = "5s";
          # On SIGTERM the broker saves a refresh still in flight, waiting up
          # to 125 s; killing it sooner leaves a spent refresh token.
          TimeoutStopSec = 130;
          # The broker is no broker client, and serves the default profile's
          # store with the token file above.
          UnsetEnvironment = "OMP_AUTH_BROKER_URL OMP_AUTH_BROKER_TOKEN PI_CONFIG_DIR OMP_PROFILE PI_PROFILE";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
    (lib.mkIf (cfg.url != null) {
      home.sessionVariables.OMP_AUTH_BROKER_URL = cfg.url;
      systemd.user.sessionVariables = lib.mkIf pkgs.stdenv.hostPlatform.isLinux { OMP_AUTH_BROKER_URL = cfg.url; };
    })
  ];
}
