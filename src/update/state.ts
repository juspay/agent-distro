/**
 * The files a package's state directory holds (`lib/state-directory.nix` names
 * the directory): the `current` link the shims prefer — the package an update
 * last installed — and the `last-success` stamp a scheduled run reads
 * (`./due.ts`' `parseStamp`). The updater writes both; a consumer that installs
 * packages itself (kolu) writes the same two, so the shims and the schedule
 * read them the same way whoever wrote them.
 */

/** The link naming the package this state directory serves. */
export function currentLink(state: string): string {
  return `${state}/current`;
}

/** The stamp of the last successful update, in epoch seconds. */
export function lastSuccessFile(state: string): string {
  return `${state}/last-success`;
}
