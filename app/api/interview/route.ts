import { NextResponse } from 'next/server'
import { buildSystemPrompt } from '@/lib/interview/prompt'
import { buildTurnSchema } from '@/lib/interview/schema'
import { composeMessage } from '@/lib/interview/render'
import {
  allowedActions,
  applyTurn,
  createInitialState,
  isOpeningTurn,
  normalizeState,
} from '@/lib/interview/state'
import { ALL_FORMATS } from '@/lib/interview/types'
import type { InterviewState, ModelTurn, QuestionFormat, TurnAction, TurnRender } from '@/lib/interview/types'

export const maxDuration = 60

/**
 * Model configuration lives here so swapping models later is a one-line change.
 * Nothing below assumes a specific model family: optional parameters are
 * stripped and retried if the endpoint rejects them.
 */
const MODEL = process.env.INTERVIEW_MODEL || 'gpt-5.2'
const MAX_OUTPUT_TOKENS = Number(process.env.INTERVIEW_MAX_OUTPUT_TOKENS || 4000)
const REASONING_EFFORT = process.env.INTERVIEW_REASONING_EFFORT || 'medium'
const OPENAI_URL = 'https://api.openai.com/v1/responses'
/**
 * Abort before the platform kills the function, so a stalled upstream call
 * returns a clean error with the interview state intact instead of a 504.
 * Upstream turns normally land in 10-20s; stalls have been seen to run minutes.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.INTERVIEW_TIMEOUT_MS || 50000)

export async function POST(request: Request) {
  let state: InterviewState | null = null

  try {
    const body = await request.json()
    const messages = Array.isArray(body?.messages) ? body.messages : []

    // Legacy callers (pre-engine clients still holding an old bundle) send a
    // prebuilt systemMessage and no state. Keep them working unchanged.
    if (!body?.state && typeof body?.systemMessage === 'string') {
      const message = await runLegacyTurn(messages, body.systemMessage)
      return NextResponse.json({ message })
    }

    const fallbackState = createInitialState({
      mode: body?.mode === 'real' ? 'real' : 'practice',
      type: body?.type || 'mixed',
      customTopic: body?.customTopic || '',
    })
    state = normalizeState(body?.state, fallbackState)

    if (state.complete) {
      return NextResponse.json({
        message: 'This interview is already complete. Start a new one to keep practicing.',
        render: {
          spoken: 'This interview is already complete. Start a new one to keep practicing.',
          evaluation: null,
          withheldReviews: [],
          finalReport: null,
          allEvaluations: state.evaluations,
        },
        state,
        turnKind: state.turnKind,
        questionAsked: '',
        evaluation: null,
        finalReport: state.finalReport,
        complete: true,
      })
    }

    const recentQuestions: string[] = Array.isArray(body?.recentQuestions)
      ? body.recentQuestions.filter((q: any) => typeof q === 'string')
      : []
    const seed = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

    const systemPrompt = buildSystemPrompt(state, { recentQuestions, seed })
    const schema = buildTurnSchema(state)

    const input = [
      { role: 'developer', content: systemPrompt },
      ...messages.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: String(msg.content ?? ''),
      })),
    ]

    if (isOpeningTurn(state) && messages.length === 0) {
      input.push({ role: 'user', content: 'Begin the interview.' })
    }

    const { turn, degraded } = await runTurn(input, schema, state)
    const nextState = applyTurn(state, turn)
    const message = composeMessage({
      state: nextState,
      displayText: turn.display_text,
      evaluation: turn.evaluation,
      finalReport: nextState.finalReport,
    })

    const practice = nextState.mode !== 'real'
    const render: TurnRender = {
      spoken: (turn.display_text || '').trim() || (degraded ? message : ''),
      // Real Mode withholds every review until the interview is over.
      evaluation: practice ? turn.evaluation : null,
      withheldReviews: !practice && nextState.complete ? nextState.evaluations : [],
      finalReport: nextState.finalReport,
      allEvaluations: nextState.complete ? nextState.evaluations : [],
    }

    return NextResponse.json({
      message: message || 'Could you expand on that?',
      render,
      state: nextState,
      turnKind: nextState.turnKind,
      questionAsked: turn.question_asked || '',
      evaluation: turn.evaluation,
      finalReport: nextState.finalReport,
      complete: nextState.complete,
      degraded,
    })
  } catch (error: any) {
    console.error('Interview API error:', error)
    const timedOut = /took too long/i.test(error?.message || '')
    return NextResponse.json(
      {
        message: timedOut
          ? error.message
          : 'Interview service temporarily unavailable. Please try again.',
        render: null,
        // Echo state back untouched so a failed turn never corrupts the interview.
        state,
        turnKind: state?.turnKind ?? 'opening',
        questionAsked: '',
        evaluation: null,
        finalReport: null,
        complete: false,
      },
      { status: 500 }
    )
  }
}

/**
 * Calls the model and returns a validated turn. Falls back to a plain-text turn
 * rather than failing the interview if structured output is unavailable.
 */
async function runTurn(
  input: any[],
  schema: ReturnType<typeof buildTurnSchema>,
  state: InterviewState
): Promise<{ turn: ModelTurn; degraded: boolean }> {
  const { data, droppedFormat } = await callModel({
    model: MODEL,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    ...(REASONING_EFFORT && REASONING_EFFORT !== 'off'
      ? { reasoning: { effort: REASONING_EFFORT } }
      : {}),
    text: { format: { type: 'json_schema', ...schema } },
  })

  const raw = extractOutputText(data)
  if (!raw) {
    const reason = data?.incomplete_details?.reason || data?.status || 'empty response'
    throw new Error(`Model returned no usable output (${reason})`)
  }

  if (!droppedFormat) {
    const parsed = parseJson(raw)
    if (parsed) return { turn: coerceTurn(parsed, state), degraded: false }
  }

  // Structured output unavailable or unparseable: keep the interview alive with
  // the raw text as the interviewer's line.
  console.warn('Interview: falling back to plain-text turn')
  return { turn: degradedTurn(raw, state), degraded: true }
}

/**
 * Posts to the Responses API, stripping optional parameters and retrying if the
 * endpoint rejects them. Keeps the route portable across model versions.
 */
async function callModel(payload: Record<string, any>): Promise<{ data: any; droppedFormat: boolean }> {
  let body = { ...payload }
  let droppedFormat = false

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error('The interviewer took too long to respond. Send your answer again.')
      }
      throw err
    }

    const data = await response.json()
    if (response.ok) return { data, droppedFormat }

    const errorMessage: string = data?.error?.message || 'OpenAI API error'
    console.error('OpenAI API error:', errorMessage)

    const unsupported = /unsupported|unknown|unrecognized|not supported|invalid.*parameter/i.test(
      errorMessage
    )
    if (response.status === 400 && unsupported && 'reasoning' in body && /reasoning|effort/i.test(errorMessage)) {
      const { reasoning, ...rest } = body
      body = rest
      continue
    }
    if (
      response.status === 400 &&
      unsupported &&
      'text' in body &&
      /json_schema|text\.format|format|schema|structured/i.test(errorMessage)
    ) {
      const { text, ...rest } = body
      body = rest
      droppedFormat = true
      continue
    }
    throw new Error(errorMessage)
  }

  throw new Error('OpenAI API error: exhausted parameter fallbacks')
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }
  const messages = Array.isArray(data?.output) ? data.output.filter((i: any) => i?.type === 'message') : []
  for (const message of messages) {
    const parts = Array.isArray(message?.content) ? message.content : []
    const part = parts.find((p: any) => p?.type === 'output_text') || parts[0]
    if (typeof part?.text === 'string' && part.text.trim()) return part.text.trim()
    if (typeof part?.refusal === 'string' && part.refusal.trim()) return part.refusal.trim()
  }
  return ''
}

function parseJson(raw: string): any | null {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** Forces the model's turn back inside what the state machine permits. */
function coerceTurn(parsed: any, state: InterviewState): ModelTurn {
  const permitted = allowedActions(state)
  const action: TurnAction = permitted.includes(parsed?.action) ? parsed.action : defaultAction(permitted)
  return {
    action,
    display_text: typeof parsed?.display_text === 'string' ? parsed.display_text : '',
    question_asked: typeof parsed?.question_asked === 'string' ? parsed.question_asked : '',
    scenario_label: typeof parsed?.scenario_label === 'string' ? parsed.scenario_label : '',
    category: ['clinical', 'emotional', 'behavioral', 'custom'].includes(parsed?.category)
      ? parsed.category
      : state.currentCategory || 'clinical',
    question_format: coerceFormat(parsed?.question_format),
    concepts_tested: Array.isArray(parsed?.concepts_tested) ? parsed.concepts_tested : [],
    difficulty_level: parsed?.difficulty_level ?? state.suggestedDifficulty,
    // An evaluation only counts on a turn that actually closes a scenario.
    evaluation: action === 'ask_follow_up' ? null : (parsed?.evaluation ?? null),
    final_report: action === 'final_report' ? (parsed?.final_report ?? null) : null,
    internal_note: typeof parsed?.internal_note === 'string' ? parsed.internal_note : '',
  }
}

function degradedTurn(raw: string, state: InterviewState): ModelTurn {
  const permitted = allowedActions(state)
  return {
    action: defaultAction(permitted),
    display_text: raw,
    question_asked: raw.split('\n').find((line) => line.includes('?'))?.trim() || '',
    scenario_label: state.currentScenario,
    category: state.currentCategory || 'clinical',
    question_format: 'none',
    concepts_tested: [],
    difficulty_level: state.suggestedDifficulty,
    evaluation: null,
    final_report: null,
    internal_note: 'degraded plain-text turn',
  }
}

function coerceFormat(value: any): QuestionFormat {
  return ALL_FORMATS.includes(value) ? value : 'none'
}

function defaultAction(permitted: TurnAction[]): TurnAction {
  if (permitted.includes('next_primary')) return 'next_primary'
  if (permitted.includes('ask_follow_up')) return 'ask_follow_up'
  return permitted[0] || 'final_report'
}

/** Original pre-engine behaviour, kept for clients that have not reloaded. */
async function runLegacyTurn(messages: any[], systemMessage: string): Promise<string> {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'developer', content: systemMessage },
        ...messages.map((msg: any) => ({ role: msg.role, content: msg.content })),
      ],
      max_output_tokens: 800,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const data = await response.json()
  if (!response.ok) {
    console.error('OpenAI API error:', data)
    throw new Error(data.error?.message || 'OpenAI API error')
  }
  return extractOutputText(data) || 'Could you please repeat that?'
}
