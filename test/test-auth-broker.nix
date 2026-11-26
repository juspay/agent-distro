# The OMP auth broker options, VM-free: the unit and variables each side
# generates, the assertions, and the service's start script refusing to start
# without a token or a Tailscale address.
{ pkgs, nixpkgs, agent-distro, home-manager }:
let
  inherit (nixpkgs) lib;
  homeOf = system: broker: (home-manager.lib.homeManagerConfiguration {
    pkgs = nixpkgs.legacyPackages.${system};
    modules = [
      agent-distro.homeManagerModules.default
      {
        home = { username = "testuser"; homeDirectory = "/home/testuser"; stateVersion = "24.05"; };
        # No `services.agent-distro.enable`: the broker stands on its own.
        services.agent-distro.omp.authBroker = broker;
      }
    ];
  }).config;
  failed = config: builtins.filter (a: !a.assertion) config.assertions;
  tokenFile = "/run/secrets/omp-auth-broker-token";

  server = homeOf "x86_64-linux" { serve.enable = true; inherit tokenFile; };
  unit = server.systemd.user.services.agent-distro-omp-auth-broker;
  fixed = homeOf "x86_64-linux" { serve = { enable = true; address = "127.0.0.1"; port = 9999; }; };
  # Home Manager stores ExecStart as a list.
  startOf = config: builtins.head (lib.toList config.systemd.user.services.agent-distro-omp-auth-broker.Service.ExecStart);
  start = startOf server;
  fixedStart = startOf fixed;

  url = "http://broker-host:8765";
  client = homeOf "x86_64-linux" { inherit url tokenFile; };
  darwinClient = homeOf "aarch64-darwin" { inherit url; };
in
# The server: a user service with the stop timeout a saved refresh needs, and
# no broker variables of its own.
assert failed server == [ ];
assert unit.Unit.StartLimitIntervalSec == 0;
assert unit.Service.Restart == "on-failure";
assert unit.Service.RestartSec == "5s";
assert unit.Service.TimeoutStopSec == 130;
assert unit.Install.WantedBy == [ "default.target" ];
assert lib.hasInfix "OMP_AUTH_BROKER_URL" unit.Service.UnsetEnvironment;
assert !(server.home.sessionVariables ? OMP_AUTH_BROKER_URL);
assert !(server.systemd.user.sessionVariables ? OMP_AUTH_BROKER_URL);
assert server.home.file ? ".omp/auth-broker.token";
# Without a token file the module leaves ~/.omp/auth-broker.token alone.
assert !(fixed.home.file ? ".omp/auth-broker.token");
# The client: the URL reaches shells and user services alike.
assert failed client == [ ];
assert client.home.sessionVariables.OMP_AUTH_BROKER_URL == url;
assert client.systemd.user.sessionVariables.OMP_AUTH_BROKER_URL == url;
assert !(client.systemd.user.services ? agent-distro-omp-auth-broker);
assert client.home.file ? ".omp/auth-broker.token";
assert failed darwinClient == [ ];
assert darwinClient.home.sessionVariables.OMP_AUTH_BROKER_URL == url;
# Server and client on one machine, or a server without systemd, are refused.
assert !(builtins.tryEval (homeOf "x86_64-linux" { serve.enable = true; inherit url; }).home.activationPackage.drvPath).success;
assert !(builtins.tryEval (homeOf "aarch64-darwin" { serve.enable = true; }).home.activationPackage.drvPath).success;
# Nothing set, nothing generated.
assert !((homeOf "x86_64-linux" { }).home.sessionVariables ? OMP_AUTH_BROKER_URL);
assert !((homeOf "x86_64-linux" { }).systemd.user.services ? agent-distro-omp-auth-broker);
pkgs.runCommand "auth-broker" { } ''
  set -u
  # The token file is a link to where the secret manager puts it, so the
  # store holds the path and never the token.
  [ "$(readlink ${server.home.file.".omp/auth-broker.token".source})" = ${tokenFile} ]
  # An explicit address and port, and no Tailscale lookup.
  grep -qF -- '--bind="$address:9999"' ${fixedStart}
  grep -qF -- "127.0.0.1" ${fixedStart}
  if grep -q tailscale ${fixedStart}; then echo "a fixed address still asks Tailscale" >&2; exit 1; fi

  export HOME=$PWD/home
  mkdir -p "$HOME"
  # No token: refused before anything is bound, since `serve` would otherwise
  # mint one no client knows.
  if ${start} 2>err; then echo "started without a token" >&2; exit 1; fi
  grep -q "no token at $HOME/.omp/auth-broker.token" err
  # A token but no Tailscale (the build sandbox has none): refused too, so the
  # service retries until Tailscale is up.
  mkdir -p "$HOME/.omp"
  echo test-token > "$HOME/.omp/auth-broker.token"
  if ${start} 2>err; then echo "started without Tailscale" >&2; exit 1; fi
  grep -q "is Tailscale up?" err
  touch "$out"
''
