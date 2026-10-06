# OMP

Passes plugins as `-e` roots, composing with user extensions. A plugin on
`AGENT_DISTRO_PLUGINS` is validated and passed as one more `-e` root, its own
directory, replacing a profile plugin of the same name. A gateway
prompts for its key, sets the LiteLLM environment, and fills absent model roles
in user YAML while preserving existing values and comments. Every profile fills
`hideThinkingBlock: true`, so thinking blocks stay hidden; set it to `false` in
`config.yml` to show them again.

OMP uses an npins release pin. Its source build is loaded from upstream's lock,
except that every nixpkgs in it is the distribution's shared nixpkgs.
