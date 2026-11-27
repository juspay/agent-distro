# OMP

Passes plugins as `-e` roots, composing with user extensions. A plugin on
`AGENT_DISTRO_PLUGINS` is validated and passed as one more `-e` root, its own
directory, replacing a plugin of a profile in effect that has the same name. A
profile read at launch (a `plugin.json`) reaches OMP the same way. Its stdio MCP servers run through a generated launcher, in the directory the
launch was typed in (doc/index.md, "Working directory"). The environment and
the `settings.omp` of the profile in effect, read at launch, are exported
before OMP starts — a `secret` variable is prompted for when it is not already
set — and its YAML fills only the keys the user has not set, preserving
existing values and comments. A profile with a `settings.omp` section has
already made the choices the setup wizard asks for, so the launcher exports
`OMP_SKIP_SETUP=1` (never over a value you exported yourself); with none, the
wizard runs as upstream intends. Every profile fills `hideThinkingBlock: true`
and `task.showResolvedModelBadge: true`, so thinking blocks stay hidden and a
subagent's row names the model it resolved to; set either to `false` in
`config.yml` to turn it off again. It also fills `tui.resizeScrollback:
preserve`: OMP's own `rebuild` clears the terminal's scrollback and reprints
the whole transcript on every width change and every height shrink
(1.7 million characters for a 3.7 MB session, measured, even for a
one-column change), which a relayed terminal has to deliver every time.
`preserve` repaints only the visible screen; the price is that scrollback
above it keeps the wrapping it had, because OMP no longer rewrites it. Set
`tui.resizeScrollback: rebuild` in `config.yml` for upstream's behaviour
(`append` is the third value: reprint below the old scrollback instead of
erasing it). Every profile also fills `composer.predictions: false`: since
19.0.0 OMP asks the model, after every completed turn, for a guess at your
next message and shows it greyed out in the empty input box, and each guess
is one more billed request over the whole conversation. Set
`composer.predictions: true` in `config.yml`, or turn on Composer Predictions
in `/settings`, to have them back.

OMP uses an npins release pin, fetched by the revision npins resolved its tag
to rather than by the tag: upstream re-points release tags after publishing,
and a fetch by tag then fails the pinned hash. A moved tag changes nothing that
is built; the pin moves only when npins writes a new revision. Its source build is
loaded from upstream's lock, except that every nixpkgs in it is the
distribution's shared nixpkgs.

## Auth broker

`home-manager/auth-broker.nix` is the Home Manager glue for
`services.agent-distro.omp.authBroker`, exported as
`homeManagerModules.omp-auth-broker`; `auth-broker.nix` is the program its
unit runs, a plain function of `pkgs`, OMP's package, the address and the
port, so a NixOS unit can run the same program without Home Manager. Its
check is `tests/auth-broker.nix`, run as `omp-auth-broker`.

- **Upstream's OMP, not the launcher.** The unit runs
  `agent-distro.harnesses.<system>.omp`: the launcher prompts for a profile's
  `secret` variables and stops when stdin is not a terminal, so it cannot run
  as a service. That OMP moves when the configuration is rebuilt, not with the
  scheduled updates; upstream tolerates a broker and clients of different
  versions.
- **The token file.** OMP reads the bearer token from
  `<config-root>/auth-broker.token`, `~/.omp/auth-broker.token` for the
  default profile, on the broker and on a client. `tokenFile` makes that path
  an out-of-store symlink to the secret manager's file, so the store holds the
  path, never the token. OMP's other routes are not used:
  `OMP_AUTH_BROKER_TOKEN` would put the token in the environment, and
  `auth.broker.token` lives in `config.yml`, which OMP and the launcher both
  write.
- **Never without a token.** Upstream `serve` writes a fresh token when the
  file is missing, which no client would know, so the program refuses to
  start without one.
- **The address.** With no `serve.address`, the program reads
  `tailscale ip -4` at each start and fails while there is no IPv4. A user
  unit cannot order itself after the system's `tailscaled`, so
  `Restart=on-failure`, `RestartSec=5s` and `StartLimitIntervalSec=0` retry
  until there is one, and no address is written into the unit.
- **What the unit clears.** `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`
  (the broker is no client); `PI_CONFIG_DIR`, `OMP_PROFILE` and `PI_PROFILE`
  (they move the token file); `PI_CODING_AGENT_DIR` and `XDG_DATA_HOME` (they
  move `agent.db`). So the broker always serves `~/.omp/agent/agent.db` with
  `~/.omp/auth-broker.token`, whatever the user manager's environment says.
- **Stop timeout.** On SIGTERM the broker waits up to 125 s to save a refresh
  in flight; upstream asks a supervisor to allow 130, which `TimeoutStopSec`
  does. A kill sooner leaves a spent refresh token.
- **Broker or client, not both.** OMP on the broker reads its store directly,
  and SQLite leases coordinate its refreshes with the broker's; an assertion
  refuses `serve.enable` with `url`.
- **What the system provides.** Home Manager cannot open the port in the
  firewall or enable lingering; the user documentation names the NixOS
  options for both.
