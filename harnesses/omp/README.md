# OMP

Passes plugins as `-e` roots, composing with user extensions. A gateway
prompts for its key, sets the LiteLLM environment, and fills absent model roles
in user YAML while preserving existing values and comments. Each defaulted role
carries the `:off` thinking suffix, so a session starts with reasoning disabled
(OMP's `defaultThinkingLevel` enum has no `off`, but a role selector's `:level`
suffix does).

OMP uses an npins release pin. Its source build is loaded with the shared
pinned flake-compat, honouring upstream’s lock to preserve binary-cache paths.
