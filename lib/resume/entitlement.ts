/**
 * Server-side tier enforcement for Resume V2.
 *
 * Every limit is decided from the verified session, never from the request body
 * and never from the UI. V1's one-resume cap lived in a landing-page
 * conditional, so navigating straight to /resume-builder/create walked past it.
 * Here the count is taken inside the create endpoint and the UI gate is a
 * courtesy.
 *
 * THE MONETISATION MODEL, as locked:
 *
 *   Free      1 resume
 *   Premium   1 resume
 *   Ultimate  unlimited
 *
 * Every tier gets the WHOLE builder: all templates, import, AI, Resume
 * Strength, section controls, and a clean multi-page preview with no mark on
 * it. What Ultimate adds is taking the finished file away -- the download, and
 * marking a resume complete. The old "preview only" framing, where a Free
 * preview carried an upgrade watermark, is gone: someone should be able to
 * finish their resume and see it before deciding to pay for it.
 *
 * AI IS NOT METERED. There is no monthly allowance, nothing counts down, and
 * nothing is displayed. What exists instead is invisible abuse protection: a
 * burst ceiling that a person building a resume will never reach and a script
 * will. When it trips, the caller is told to try again shortly -- never that
 * they need to upgrade, and never how many calls they have left, because
 * neither is true and both would turn an anti-abuse measure into a fake quota.
 *
 * Pure. Takes a tier string and some counts; touches no database, no session
 * and no network, so every rule here is unit-tested.
 */

export type Tier = 'free' | 'premium' | 'ultimate'

/** Anything unrecognised is the lowest tier. An error is never a way up. */
export function normaliseTier(value: string | null | undefined): Tier {
  const tier = (value ?? '').trim().toLowerCase()
  if (tier === 'ultimate') return 'ultimate'
  if (tier === 'premium') return 'premium'
  return 'free'
}

// ---------------------------------------------------------------------------
// Resumes
// ---------------------------------------------------------------------------

/** `null` means unlimited. */
export function resumeLimitFor(tier: string | null | undefined): number | null {
  switch (normaliseTier(tier)) {
    case 'ultimate': return null
    case 'premium': return 1
    case 'free': return 1
  }
}

export const RESUME_LIMIT_CODE = 'resume-limit-reached'
export const FINALIZE_CODE = 'finalize-requires-ultimate'
export const EXPORT_CODE = 'export-requires-ultimate'
/** Deliberately not an entitlement code: see the note at the top of the file. */
export const RATE_LIMIT_CODE = 'too-many-requests'

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string }

const allow: Decision = { allowed: true }

/**
 * Whether another resume may be created, given how many already exist.
 *
 * The count is the caller's job to take from the database; this decides what it
 * means. Separating them is what lets the rule be tested without a database and
 * the count be taken inside the transaction that creates the row.
 */
export function decideCreateResume(input: {
  readonly tier: string | null | undefined
  readonly currentCount: number
}): Decision {
  const limit = resumeLimitFor(input.tier)
  if (limit === null) return allow
  if (input.currentCount < limit) return allow

  return {
    allowed: false,
    code: RESUME_LIMIT_CODE,
    message: limit === 1
      ? 'Your plan includes one resume. Upgrade to Ultimate for unlimited resumes.'
      : `Your plan includes ${limit} resumes. Upgrade to Ultimate for unlimited resumes.`,
  }
}

// ---------------------------------------------------------------------------
// Finalising and exporting — the gate
// ---------------------------------------------------------------------------

/** Marking a resume complete. Ultimate only. */
export function canFinalize(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

/** Taking the finished file away. Ultimate only, both formats. */
export function canExportPdf(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

export function canExportDocx(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

export function decideFinalize(tier: string | null | undefined): Decision {
  return canFinalize(tier)
    ? allow
    : {
        allowed: false,
        code: FINALIZE_CODE,
        message: 'Marking a resume complete is an Ultimate feature.',
      }
}

export function decideExport(tier: string | null | undefined): Decision {
  return canExportPdf(tier)
    ? allow
    : {
        allowed: false,
        code: EXPORT_CODE,
        message: 'Downloading your finished resume is an Ultimate feature.',
      }
}

/**
 * Whether the finished document must be held back from this tier.
 *
 * The same question as the export gate, asked about what is on screen. It does
 * NOT mark or restrict the preview while someone is building: it is what makes
 * a download attempt open the upgrade modal instead of producing a file, and
 * what keeps a locked preview locked. See lib/resume/studio/outputLock.ts.
 */
export function outputGated(tier: string | null | undefined): boolean {
  return !canExportPdf(tier)
}

// ---------------------------------------------------------------------------
// AI: no quota, only abuse protection
// ---------------------------------------------------------------------------

/** Every tier may use the AI workflow. There is no AI entitlement to check. */
export function canUseAi(_tier: string | null | undefined): boolean {
  return true
}

export interface RateWindow {
  readonly windowMs: number
  readonly max: number
}

/**
 * Approved ceilings. Sized so a person writing a resume never meets them and a
 * script does: ten in a minute is faster than anyone reads a proposal, and a
 * hundred and fifty in a day is far past finishing one resume.
 */
export const AI_RATE_LIMITS: readonly RateWindow[] = [
  { windowMs: 60_000, max: 10 },
  { windowMs: 60 * 60_000, max: 60 },
  { windowMs: 24 * 60 * 60_000, max: 150 },
]

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly message: string }

/**
 * Whether another AI call may be made, given when the recent ones happened.
 *
 * `recent` is a list of epoch-millisecond timestamps from the usage ledger. The
 * caller supplies them; this decides. Windows are sliding, not bucketed, so the
 * limit cannot be doubled by straddling a boundary.
 *
 * The message says nothing about plans, allowances or remaining calls. It is a
 * rate-limit response, and dressing it as an upgrade prompt would be a lie that
 * also trains people to expect a quota that does not exist.
 */
export function checkAiRate(
  recent: readonly number[],
  now: number,
  limits: readonly RateWindow[] = AI_RATE_LIMITS
): RateDecision {
  let retryAfterMs = 0

  for (const limit of limits) {
    const since = now - limit.windowMs
    const inWindow = recent.filter((at) => at > since).sort((a, b) => a - b)
    if (inWindow.length < limit.max) continue

    // Room appears when the oldest call in this window falls out of it.
    const oldest = inWindow[inWindow.length - limit.max]
    retryAfterMs = Math.max(retryAfterMs, oldest + limit.windowMs - now)
  }

  if (retryAfterMs <= 0) return { allowed: true }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    message: 'Too many requests just now. Please try again shortly.',
  }
}

/** The longest window the ledger has to be read back over. */
export function rateLedgerWindowMs(limits: readonly RateWindow[] = AI_RATE_LIMITS): number {
  return limits.reduce((widest, limit) => Math.max(widest, limit.windowMs), 0)
}
