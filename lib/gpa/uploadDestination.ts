/**
 * Where an uploaded transcript should go.
 *
 * The three outcomes are named, rather than being encoded as a boolean, because
 * this used to be a browser confirm() where "OK" meant "start a new analysis"
 * and "Cancel" meant "add to the current one" -- leaving no way at all to
 * actually cancel the upload.
 *
 * D47: neither destination modifies the analysis that is open. 'separate'
 * analyzes the transcript on its own, and 'combine' analyzes it once and puts
 * it together with a COPY of the open analysis in a new one.
 */
export type UploadDestination = 'separate' | 'combine' | 'cancel'

/** True when the choice should leave the draft completely untouched. */
export function isCancelled(choice: UploadDestination): boolean {
  return choice === 'cancel'
}

/** The analysis label shown when a draft has never been named. */
export const UNNAMED_ANALYSIS = 'Untitled Analysis'

/**
 * The analysis name as it appears inside a button.
 *
 * Long names are truncated so the control cannot stretch a 375px viewport, and
 * a blank name falls back to the same label the switcher shows.
 */
export function shortenAnalysisName(raw: string | null | undefined, max = 28): string {
  const name = String(raw ?? '').trim() || UNNAMED_ANALYSIS
  if (name.length <= max) return name
  return name.slice(0, max - 1).trimEnd() + '…'
}
