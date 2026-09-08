/**
 * Transcript import progress.
 *
 * A transcript analysis legitimately takes tens of seconds, and sometimes more
 * than a minute. The old experience showed a spinning "Analyzing…" label on one
 * button, which left the user unable to tell a slow analysis from a frozen page
 * -- and re-uploading is the worst possible response, because it starts a
 * second analysis of the same document.
 *
 * Everything here is pure. Two rules shape it:
 *
 *   1. No invented progress. There is no percentage, and no bar that advances
 *      on a timer: the client cannot see inside an OpenAI request, so claiming
 *      it is 73% done would be a lie. Stages move only when the application
 *      genuinely knows the previous one finished.
 *
 *   2. No invented promises. The elapsed time is measured, never estimated, and
 *      nothing offers background processing, because the request lives in the
 *      page and dies with it.
 */

export type ImportStageId = 'received' | 'reading' | 'analyzing' | 'validating' | 'importing'

/**
 * The stages the client can actually observe.
 *
 * Deliberately coarse. The analyzer request hides institution detection, legend
 * applicability and course extraction inside one call, so they are represented
 * as the one thing the client knows is happening rather than split into steps
 * it would only be guessing at.
 */
export const IMPORT_STAGES: { id: ImportStageId; label: string; detail: string }[] = [
  { id: 'received', label: 'Upload received', detail: 'Your file was accepted.' },
  { id: 'reading', label: 'Reading transcript', detail: 'Extracting the text and page layout.' },
  { id: 'analyzing', label: 'Analyzing coursework and grading information',
    detail: 'Reading courses, terms, credits and any grading legend.' },
  { id: 'validating', label: 'Validating results',
    detail: 'Checking what was found against the transcript’s own rows and totals.' },
  { id: 'importing', label: 'Preparing your GPA analysis',
    detail: 'Organizing coursework and schools.' },
]

export type ImportPhase = 'idle' | 'running' | 'success' | 'error'

export type FailureKind =
  | 'timeout'        // the analysis service took too long
  | 'service'        // upstream returned an error
  | 'network'        // the request never completed
  | 'unreadable'     // not enough text in the document to analyze
  | 'too-large'      // beyond the size the pipeline accepts
  | 'not-allowed'    // signed out, or not on a plan that includes analysis
  | 'allowance-used' // D60: this account's one transcript analysis is spent
  | 'analysis-limit' // D35's 50-analysis cap, caught BEFORE anything was spent
  | 'limit'         // analyzed fine, but the new analysis could not be created
  | 'unknown'

/** 'fill' is an analysis that is still empty, so the transcript simply fills it. */
export type ImportDestination = 'separate' | 'combine' | 'fill'

export interface ImportState {
  phase: ImportPhase
  /** The furthest stage actually reached. */
  stage: ImportStageId
  /** When analysis really began, so the timer measures rather than estimates. */
  startedAt: number | null
  endedAt: number | null
  /** Analyzer requests made, including the purposeful second pass. */
  attempts: number
  structuralRetry: boolean
  scaleRetry: boolean
  destination: ImportDestination | null
  /** The analysis that is open, for combine wording. Never re-analyzed. */
  analysisName: string | null
  fileName: string | null
  failure: FailureKind | null
  /** True when the same file is worth sending again. */
  canRetry: boolean
}

export const IDLE_IMPORT: ImportState = {
  phase: 'idle', stage: 'received', startedAt: null, endedAt: null,
  attempts: 0, structuralRetry: false, scaleRetry: false,
  destination: null, analysisName: null, fileName: null,
  failure: null, canRetry: false,
}

export function beginImport(input: {
  destination: ImportDestination
  analysisName?: string | null
  fileName?: string | null
  now: number
}): ImportState {
  return {
    ...IDLE_IMPORT,
    phase: 'running', stage: 'received', startedAt: input.now,
    destination: input.destination,
    analysisName: input.analysisName ?? null,
    fileName: input.fileName ?? null,
  }
}

const ORDER: ImportStageId[] = IMPORT_STAGES.map(s => s.id)

/** Moves to a stage the application has genuinely reached. Never backwards. */
export function advance(state: ImportState, stage: ImportStageId): ImportState {
  if (state.phase !== 'running') return state
  return ORDER.indexOf(stage) <= ORDER.indexOf(state.stage) ? state : { ...state, stage }
}

/** Records a real analyzer request, and why a second one was made. */
export function noteAttempt(
  state: ImportState, reason?: 'structural' | 'scale',
): ImportState {
  return {
    ...state,
    attempts: state.attempts + 1,
    structuralRetry: state.structuralRetry || reason === 'structural',
    scaleRetry: state.scaleRetry || reason === 'scale',
  }
}

export function succeed(state: ImportState, now: number): ImportState {
  return { ...state, phase: 'success', stage: 'importing', endedAt: now, failure: null, canRetry: false }
}

export function fail(state: ImportState, failure: FailureKind, now: number): ImportState {
  return { ...state, phase: 'error', endedAt: now, failure, canRetry: isRetryable(failure) }
}

/** Cancelling before analysis starts leaves no trace at all. */
export function cancelImport(): ImportState {
  return IDLE_IMPORT
}

export function isRunning(state: ImportState): boolean {
  return state.phase === 'running'
}

/** A second transcript may not be started while one is being analyzed. */
export function canStartImport(state: ImportState): boolean {
  return state.phase !== 'running'
}

/** Why an upload control is temporarily unavailable, or null when it is not. */
export function blockedUploadReason(state: ImportState): string | null {
  return state.phase === 'running' ? 'Transcript analysis in progress' : null
}

// ------------------------------------------------------------------- elapsed
export function elapsedMs(state: ImportState, now: number): number {
  if (state.startedAt === null) return 0
  const end = state.endedAt ?? now
  return Math.max(0, end - state.startedAt)
}

/** "0:07", "1:07", "12:34". Measured, never estimated, and never a countdown. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// --------------------------------------------------------------- reassurance
/**
 * Time-based reassurance. None of it implies a deadline, and none of it calls
 * the process stuck merely because it is taking a while.
 */
export function reassuranceFor(ms: number): string {
  if (ms >= 150_000) {
    return 'Still working. We’re validating the coursework we found before showing your GPA.'
  }
  if (ms >= 80_000) {
    return 'Your transcript is still being analyzed. Please don’t upload it again while this analysis is running.'
  }
  if (ms >= 40_000) {
    return 'Still working — detailed transcripts can take a little longer.'
  }
  return 'Reading and analyzing your transcript. This can take a few minutes for detailed or multi-page files.'
}

// ------------------------------------------------------------------- stages
export type StageStatus = 'done' | 'active' | 'pending'

export function stageList(
  state: ImportState,
): { id: ImportStageId; label: string; detail: string; status: StageStatus }[] {
  const at = ORDER.indexOf(state.stage)
  return IMPORT_STAGES.map((s, i) => ({
    ...s,
    status:
      state.phase === 'success' ? 'done'
      : i < at ? 'done'
      : i === at ? (state.phase === 'error' ? 'pending' : 'active')
      : 'pending',
  }))
}

/**
 * What a screen reader is told. Stage changes only -- the elapsed timer is
 * never part of this, because announcing it every second would bury the
 * information that actually changed.
 */
export function statusAnnouncement(state: ImportState): string {
  if (state.phase === 'idle') return ''
  if (state.phase === 'success') return 'Transcript analyzed.'
  if (state.phase === 'error') return failureCopy(state.failure ?? 'unknown').title
  const stage = IMPORT_STAGES.find(s => s.id === state.stage)
  return stage ? `${stage.label}. ${stage.detail}` : ''
}

// ------------------------------------------------------------------ failures
export function isRetryable(kind: FailureKind): boolean {
  // Sending the same bytes again only makes sense when the document was fine
  // and the service was not.
  return kind === 'timeout' || kind === 'service' || kind === 'network' || kind === 'unknown'
}

export interface FailureCopy {
  title: string
  message: string
  canRetry: boolean
  /** What to do when retrying will not help. Absent when a new file is no answer. */
  secondary?: string
}

export function failureCopy(kind: FailureKind): FailureCopy {
  const CHOOSE = 'Choose Another File'
  switch (kind) {
    case 'timeout':
      return {
        title: 'We couldn’t finish analyzing your transcript',
        message: 'The analysis service took longer than expected. Your transcript file is okay — ' +
          'you can send the same file again without re-selecting it.',
        canRetry: true, secondary: CHOOSE,
      }
    case 'service':
      return {
        title: 'We couldn’t finish analyzing your transcript',
        message: 'Your file was received, but the analysis service temporarily couldn’t complete ' +
          'the request. This is on our side, not your file.',
        canRetry: true, secondary: CHOOSE,
      }
    case 'network':
      return {
        title: 'The connection dropped during analysis',
        message: 'Your file was received, but the response never arrived. Check your connection ' +
          'and send the same file again.',
        canRetry: true, secondary: CHOOSE,
      }
    case 'unreadable':
      return {
        title: 'We couldn’t read this transcript',
        message: 'We couldn’t read enough text from this transcript to analyze it. Scanned or ' +
          'photographed transcripts have no text layer to read. A PDF downloaded from your ' +
          'school’s student portal usually works.',
        canRetry: false, secondary: CHOOSE,
      }
    case 'too-large':
      return {
        title: 'That transcript is too large to analyze',
        message: 'The file is beyond the size we can analyze automatically. A PDF exported ' +
          'directly from your student portal is usually much smaller.',
        canRetry: false, secondary: CHOOSE,
      }
    case 'analysis-limit':
      return {
        // Caught before the transcript was sent anywhere, which is the whole
        // point of the check -- so the copy has to say that plainly, or a
        // Free user will assume their one transcript is gone.
        title: 'You’ve reached the limit of saved analyses',
        message: 'This account already holds the maximum number of analyses, so there is ' +
          'nowhere to put a new one. Nothing was analyzed and nothing was used up — delete ' +
          'an analysis you no longer need, then upload the same transcript again.',
        canRetry: false,
      }
    case 'limit':
      return {
        title: 'Your transcript was analyzed, but the analysis couldn’t be created',
        message: 'The coursework was read successfully, but we couldn’t create the analysis to ' +
          'hold it. Your existing analyses were not changed. Deleting an analysis you no longer ' +
          'need will free up room.',
        // Retrying would spend another analysis on a document we already read.
        canRetry: false,
      }
    case 'allowance-used':
      return {
        // Worded from the ENTITLEMENT, never from what they currently hold:
        // they may well have deleted the analysis, and deleting it does not
        // give the transcript back. Telling them to delete something would
        // send them to do damage for nothing.
        title: 'Multiple transcripts are available with Ultimate',
        message: 'You\u2019ve already used your transcript analysis. Upgrade to Ultimate to ' +
          'analyze additional transcripts and combine coursework from multiple schools. ' +
          'Adding and editing courses by hand stays available on your plan.',
        canRetry: false,
      }
    case 'not-allowed':
      return {
        title: 'Transcript analysis isn’t available on this account',
        message: 'Your session may have expired, or your plan no longer includes transcript ' +
          'analysis. Manual entry is available on every plan.',
        canRetry: false, secondary: CHOOSE,
      }
    default:
      return {
        title: 'We couldn’t finish analyzing your transcript',
        message: 'Something went wrong while analyzing this transcript. Your file was not changed, ' +
          'and nothing was added to your analyses.',
        canRetry: true, secondary: CHOOSE,
      }
  }
}

/**
 * Which failure this was.
 *
 * The distinction matters: blaming the user's file for an upstream timeout
 * sends them off to hunt for a better PDF that does not exist.
 */
export function classifyFailure(input: {
  status?: number
  imageOnly?: boolean
  name?: string
  message?: string
  /** Machine-readable reason from the API, where the status alone is ambiguous. */
  code?: string
}): FailureKind {
  // D60: a spent transcript allowance and an expired session are both 403.
  // Only the code tells them apart, and they need opposite answers -- one is
  // an upgrade, the other is a sign-in.
  if (input.code === 'transcript-allowance-used') return 'allowance-used'
  if (input.code === 'analysis-limit-reached') return 'analysis-limit'
  if (input.imageOnly) return 'unreadable'
  if (input.name === 'AbortError' || input.name === 'TimeoutError') return 'timeout'

  const status = input.status
  if (status === 504 || status === 408) return 'timeout'
  if (status === 413) return 'too-large'
  if (status === 415 || status === 422) return 'unreadable'
  if (status === 401 || status === 403) return 'not-allowed'
  if (status === 502 || status === 503 || status === 500) return 'service'

  const message = String(input.message ?? '')
  // A rejected fetch is the browser telling us the request never completed.
  if (/failed to fetch|networkerror|load failed|connection/i.test(message)) return 'network'
  if (/timed out|timeout/i.test(message)) return 'timeout'
  return 'unknown'
}

// --------------------------------------------------------------- destination
/**
 * What is about to happen, in the user's own terms.
 *
 * D47: the analysis that is open is never re-analyzed and never modified. Only
 * the uploaded transcript costs an AI call, and a combined analysis is created
 * afterwards from coursework that is already structured.
 */
export function destinationLine(state: ImportState): string {
  if (state.destination === 'fill') {
    return state.analysisName
      ? `Analyzing your transcript for “${state.analysisName}”.`
      : 'Analyzing your transcript for this analysis.'
  }
  if (state.destination === 'combine' && state.analysisName) {
    return `Analyzing the new transcript. “${state.analysisName}” will remain unchanged, and a new ` +
      `combined analysis will be created when this finishes.`
  }
  if (state.destination === 'combine') {
    return 'Analyzing the new transcript. Your current analysis will remain unchanged, and a new ' +
      'combined analysis will be created when this finishes.'
  }
  return 'Analyzing your transcript for a new analysis.'
}

/** Said plainly, because the request lives in this page and dies with it. */
export const KEEP_PAGE_OPEN = 'Please keep this page open while we analyze your transcript.'
