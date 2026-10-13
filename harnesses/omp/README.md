# OMP

Passes plugins as `-e` roots, composing with user extensions. A plugin on
`AGENT_DISTRO_PLUGINS` is validated and passed as one more `-e` root, its own
directory, replacing a profile plugin of the same name. A profile read at
launch (an `agent-distro.nix`) reaches OMP the same way, its plugins replacing
every built-in one. Its stdio MCP servers run through a generated launcher, in the directory the
launch was typed in (doc/index.md, "Working directory"). The gateway of the
profile in effect, read at launch,
prompts for its key, sets the LiteLLM environment, and fills absent model roles
in user YAML while preserving existing values and comments. Every profile fills
`hideThinkingBlock: true`, so thinking blocks stay hidden; set it to `false` in
`config.yml` to show them again.

OMP uses an npins release pin. Its source build is loaded from upstream's lock,
except that every nixpkgs in it is the distribution's shared nixpkgs.
