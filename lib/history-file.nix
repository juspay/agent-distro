# The one history log every distribution on a machine appends to — the
# updater (lib/mk-updater.nix's `history`) and any consumer recording its own
# installs there (kolu) — so `src/update/history-log.ts` keeps one file
# trimmed, and a reader reads every source's events in one place.
xdgStateHome: "${xdgStateHome}/agent-distro/history.log"
