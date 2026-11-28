# homeManagerModules.omp-auth-broker, VM-free: the unit and variables each
# side generates, the assertions, and the start program: what it hands OMP,
# and its refusals without a token or a Tailscale address.
{ pkgs, nixpkgs, agent-distro, home-manager }:
let
  inherit (nixpkgs) lib;
  homeWith = modules: system: broker: (home-manager.lib.homeManagerConfiguration {
    pkgs = nixpkgs.legacyPackages.${system};
    modules = modules ++ [{
      home = { username = "testuser"; homeDirectory = "/home/testuser"; stateVersion = "24.05"; };
      services.agent-distro.omp.authBroker = broker;
    }];
  }).config;
  # The feature alone: no updater, no shims, no `services.agent-distro.enable`.
  homeOf = homeWith [ agent-distro.homeManagerModules.omp-auth-broker ];
  failed = config: builtins.filter (a: !a.assertion) config.assertions;
  refused = config: !(builtins.tryEval config.home.activationPackage.drvPath).success;
  tokenFile = "/run/secrets/omp-auth-broker-token";

  server = homeOf "x86_64-linux" { serve.enable = true; inherit tokenFile; };
  unit = server.systemd.user.services.omp-auth-broker;
  # Home Manager stores ExecStart as a list.
  start = builtins.head (lib.toList unit.Service.ExecStart);
  noToken = homeOf "x86_64-linux" { serve.enable = true; };
  # The start program is a plain function, without Home Manager; a stand-in
  # OMP records the arguments and environment it is started with.
  standIn = pkgs.writeShellScriptBin "omp" ''
    { printf '%s\n' "$*"; env; } > "$HOME/ran"
  '';
  fixedStart = lib.getExe (import "${agent-distro}/harnesses/omp/auth-broker.nix" {
    inherit pkgs;
    package = standIn;
    address = "127.0.0.1";
    port = 9999;
  });
  # What moves the token file or agent.db, or makes OMP a client.
  cleared = [ "OMP_AUTH_BROKER_URL" "OMP_AUTH_BROKER_TOKEN" "PI_CONFIG_DIR" "OMP_PROFILE" "PI_PROFILE" "PI_CODING_AGENT_DIR" "XDG_DATA_HOME" ];

  url = "http://broker-host:8765";
  client = homeOf "x86_64-linux" { inherit url tokenFile; };
  darwinClient = homeOf "aarch64-darwin" { inherit url; };
  # `default` composes every harness module; importing this one beside it too
  # declares nothing twice.
  both = homeWith [ agent-distro.homeManagerModules.default agent-distro.homeManagerModules.omp-auth-broker ]
    "x86_64-linux" { inherit url; };
in
# The server: a user service with the stop timeout a saved refresh needs.
assert failed server == [ ];
assert unit.Unit.StartLimitIntervalSec == 0;
assert unit.Service.Restart == "on-failure";
assert unit.Service.RestartSec == "5s";
assert unit.Service.TimeoutStopSec == 130;
assert unit.Install.WantedBy == [ "default.target" ];
assert !(server.home.sessionVariables ? OMP_AUTH_BROKER_URL);
assert !(server.systemd.user.sessionVariables ? OMP_AUTH_BROKER_URL);
assert server.home.file ? ".omp/auth-broker.token";
# Without a token file the module leaves ~/.omp/auth-broker.token alone.
assert !(noToken.home.file ? ".omp/auth-broker.token");
# The client: the URL reaches shells and user services alike.
assert failed client == [ ];
assert client.home.sessionVariables.OMP_AUTH_BROKER_URL == url;
assert client.systemd.user.sessionVariables.OMP_AUTH_BROKER_URL == url;
assert !(client.systemd.user.services ? omp-auth-broker);
assert client.home.file ? ".omp/auth-broker.token";
assert failed darwinClient == [ ];
assert darwinClient.home.sessionVariables.OMP_AUTH_BROKER_URL == url;
assert failed both == [ ];
assert both.home.sessionVariables.OMP_AUTH_BROKER_URL == url;
# Server and client on one machine, or a server without systemd, are refused.
assert refused (homeOf "x86_64-linux" { serve.enable = true; inherit url; });
assert refused (homeOf "aarch64-darwin" { serve.enable = true; });
# Nothing set, nothing generated.
assert !((homeOf "x86_64-linux" { }).home.sessionVariables ? OMP_AUTH_BROKER_URL);
assert !((homeOf "x86_64-linux" { }).systemd.user.services ? omp-auth-broker);
pkgs.runCommand "omp-auth-broker" { } ''
  set -u
  # The token file is a link to where the secret manager puts it, so the
  # store holds the path and never the token.
  [ "$(readlink ${server.home.file.".omp/auth-broker.token".source})" = ${tokenFile} ]

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
  # A fixed address: no Tailscale lookup, so it starts in the sandbox, and
  # every variable that would move the token or the store, or make OMP a
  # client, is cleared whoever started it.
  ${lib.concatMapStringsSep " " (name: "${name}=set") cleared} ${fixedStart}
  [ "$(head -n 1 "$HOME/ran")" = "auth-broker serve --bind=127.0.0.1:9999" ]
  for name in ${lib.concatStringsSep " " cleared}; do
    if grep -q "^$name=" "$HOME/ran"; then echo "$name reached omp" >&2; exit 1; fi
  done
  touch "$out"
''
