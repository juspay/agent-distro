# OMP

Passes plugins as `-e` roots, composing with user extensions. A plugin on
`AGENT_DISTRO_PLUGINS` is validated and passed as one more `-e` root, its own
directory, replacing a plugin of a profile in effect that has the same name. A
profile read at launch (a `plugin.json` or an `agent-distro.nix`) reaches OMP the same way. Its stdio MCP servers run through a generated launcher, in the directory the
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
`config.yml` to turn it off again.

OMP uses an npins release pin. Its source build is loaded from upstream's lock,
except that every nixpkgs in it is the distribution's shared nixpkgs.
