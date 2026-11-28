# OMP's auth broker, as Home Manager glue: the options, the user unit, the
# token link and the client's variable. The program the unit runs is
# ../auth-broker.nix. `packages.<system>` is OMP's upstream package.
{ packages }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.agent-distro.omp.authBroker;
  # The default profile's token file, where OMP reads it on the broker and on
  # a client (oh-my-pi packages/ai/src/auth-broker/discover.ts
  # `getAuthBrokerTokenFilePath`).
  tokenPath = ".omp/auth-broker.token";
in
{
  options.services.agent-distro.omp.authBroker = {
    serve = {
      enable = lib.mkEnableOption ''
        OMP's auth broker on this machine, as the systemd user service
        `omp-auth-broker`. It serves the logins in `~/.omp/agent/agent.db` to
        every client holding the token, whatever `PI_CODING_AGENT_DIR` or
        `XDG_DATA_HOME` say. OMP on this machine reads that store directly as
        long as it uses the default one (no `PI_CODING_AGENT_DIR`, no
        `$XDG_DATA_HOME/omp`), so set `url` only on clients'';
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
        default = packages.${pkgs.stdenv.hostPlatform.system};
        defaultText = lib.literalExpression "agent-distro.harnesses.\${system}.omp";
        description = ''
          The OMP the broker runs: upstream's own, without agent-distro's
          launcher. It moves when this configuration is rebuilt, not with the
          scheduled updates.
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
        manager (agenix, sops-nix, …), never by Nix. `~/.omp/auth-broker.token`,
        where OMP's default profile reads it on the broker and on a client,
        becomes a symlink to it, so the token stays out of the Nix store and
        out of the environment. `null` leaves that file to you.
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
      systemd.user.services.omp-auth-broker = {
        Unit = {
          Description = "OMP auth broker";
          # Waiting for Tailscale or for the token is a failed start, retried
          # until it succeeds.
          StartLimitIntervalSec = 0;
        };
        Service = {
          ExecStart = lib.getExe (import ../auth-broker.nix {
            inherit pkgs;
            inherit (cfg.serve) package address port;
          });
          Restart = "on-failure";
          RestartSec = "5s";
          # On SIGTERM the broker saves a refresh still in flight, waiting up
          # to 125 s; killing it sooner leaves a spent refresh token.
          TimeoutStopSec = 130;
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
