/**
 * SIMULATED LIVE: the development-only mode that makes localhost behave as the
 * Statement Studio rollout eventually will, while production stays dark.
 *
 * WHY IT EXISTS. The 63 imported requirement sets are in production and every
 * one of them is `is_active = false`. That is correct -- they are not released
 * -- and it means the real read returns nothing, so the applicant experience
 * cannot be reviewed before launch. The alternatives were to activate rows in
 * production to make a screen work, or to review the journey somewhere other
 * than the journey. This is the third option.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY IS NODE_ENV, READ ON THE SERVER
 * ---------------------------------------------------------------------------
 * `process.env.NODE_ENV` is fixed at build time by Next and is `production` in
 * every deployed build. It is not a flag anybody can set in Vercel to turn this
 * on, not a query parameter, and NOT a NEXT_PUBLIC_* variable -- those are
 * inlined into the browser bundle and are therefore a statement about what the
 * client was told, not a boundary. A deployed build cannot enter this mode
 * however it is addressed, by whoever addresses it.
 *
 * THE OPT-OUT IS FOR DEVELOPERS, NOT FOR SAFETY. STATEMENT_SIMULATED_LIVE=off
 * returns localhost to reading production exactly as it did before, for the
 * times you want that. It can only ever turn the mode OFF; there is no value of
 * it that turns the mode on outside development, because NODE_ENV is checked
 * first and independently.
 */

/** True only in a development process that has not opted out. */
export function simulatedLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'development') return false
  return env.STATEMENT_SIMULATED_LIVE !== 'off'
}

/**
 * The one sentence the banner shows.
 *
 * IT NAMES THE COST, because the analyser here is the real one. Simulated-live
 * used to return a deterministic stub and the only thing worth saying was that
 * production was inactive; now a click reaches OpenAI and is billed, so the
 * banner has to say so before anybody clicks. The applicant-facing wording of
 * the notice and the pre-click warning lives in reviewAccess.ts with the other
 * analysis notices -- this module decides the boundary, that one speaks.
 */
export const SIMULATED_LIVE_BANNER =
  'LOCAL SIMULATED LIVE — real AI calls are billed; production stays inactive'

/**
 * Thrown instead of writing, by every surface that could have written.
 *
 * LIVES HERE so the guarded client and the local catalog builder can both throw
 * the same thing without importing each other. A reviewer who sees this name in
 * a stack trace has learnt the whole story: something tried to write, and
 * simulated-live stopped it before it left the machine.
 */
export class SimulatedLiveWriteBlocked extends Error {
  constructor(operation: string, target: string) {
    super(
      `LOCAL SIMULATED LIVE blocked a production write: ${operation} on ${target}. `
      + 'Local review never writes to Supabase. If this flow needs to persist '
      + 'something, add it to lib/statement/devMode/ rather than letting it '
      + 'reach the database.',
    )
    this.name = 'SimulatedLiveWriteBlocked'
  }
}
