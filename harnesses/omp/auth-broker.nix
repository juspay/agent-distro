# The OMP auth broker's start program: `omp auth-broker serve` on `address`
# (null: this machine's Tailscale IPv4, read at each start) and `port`, never
# without a token. A plain function, so a NixOS unit or any other consumer
# runs the same program the Home Manager module does.
#
# Upstream facts it keeps (oh-my-pi packages/coding-agent/src/cli/
# auth-broker-cli.ts): `serve` reads its bearer token from
# `<config-root>/auth-broker.token`, the default profile's being
# `~/.omp/auth-broker.token`, and writes a fresh one when that file is
# missing, which no client would know.
{ pkgs, package, address, port }:
pkgs.writeShellApplication {
  name = "omp-auth-broker";
  text = ''
    token="$HOME/.omp/auth-broker.token"
    if [ ! -r "$token" ] || [ ! -s "$token" ]; then
      echo "omp-auth-broker: error: no token at $token; place the broker's token there" >&2
      exit 1
    fi
    ${if address != null then ''
      address=${pkgs.lib.escapeShellArg address}
    '' else ''
      if ! addresses=$(${pkgs.lib.getExe pkgs.tailscale} ip -4); then
        echo "omp-auth-broker: error: no Tailscale address; is Tailscale up?" >&2
        exit 1
      fi
      address=''${addresses%%$'\n'*}
      if ! [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "omp-auth-broker: error: no Tailscale IPv4 address; is Tailscale up?" >&2
        exit 1
      fi
    ''}
    exec ${pkgs.lib.getExe package} auth-broker serve --bind="$address:${toString port}"
  '';
}
