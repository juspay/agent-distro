# OMP

Passes plugins as `-e` roots, composing with user extensions. A gateway
prompts for its key, sets the LiteLLM environment, and fills absent model roles
in user YAML while preserving existing values and comments. Every profile fills
`hideThinkingBlock: true`, so thinking blocks stay hidden; set it to `false` in
`config.yml` to show them again.

OMP uses an npins release pin. Its source build is loaded with the shared
pinned flake-compat, honouring upstream’s lock to preserve binary-cache paths.
