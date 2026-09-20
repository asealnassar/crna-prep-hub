// Assembles the `input` array sent to the model for one interview turn.
// Extracted from the API route unchanged, plus one guard: system notices are
// never presented to the model as interviewer dialogue.
import { TURN_TIMEOUT_NOTICE, TURN_UNAVAILABLE_NOTICE } from './turnProtocol.ts'

export type ModelInputMessage = { role: 'developer' | 'assistant' | 'user'; content: string }

/**
 * Notices the product shows the applicant when something goes wrong. None of
 * them is anything the interviewer said. Before the turn-failure fix, a
 * timeout notice could be saved into the transcript as an interviewer turn and
 * then replayed to the model on every later turn; this set lets the server
 * refuse to replay one, whatever the browser sends.
 */
const SYSTEM_NOTICES = new Set(
  [
    TURN_TIMEOUT_NOTICE,
    TURN_UNAVAILABLE_NOTICE,
    // Client-side notices, listed so a transcript can never smuggle them in.
    'Connection problem. Send your answer again.',
    'Something went wrong. Send your answer again.',
  ].map((notice) => notice.trim())
)

export function isSystemNotice(content: unknown): boolean {
  return typeof content === 'string' && SYSTEM_NOTICES.has(content.trim())
}

/**
 * Identical to the route's previous inline assembly for every legitimate
 * message: same roles, same `String(content ?? '')` coercion, same order, and
 * the same "Begin the interview." opener when nothing has been said yet. The
 * only difference is that an assistant message consisting solely of a system
 * notice is dropped.
 */
export function buildModelInput(
  systemPrompt: string,
  messages: unknown[],
  opts: { opening: boolean }
): ModelInputMessage[] {
  const input: ModelInputMessage[] = [{ role: 'developer', content: systemPrompt }]
  for (const raw of messages) {
    const msg = (raw ?? {}) as { role?: unknown; content?: unknown }
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    const content = String(msg.content ?? '')
    if (role === 'assistant' && isSystemNotice(content)) continue
    input.push({ role, content })
  }
  if (opts.opening) input.push({ role: 'user', content: 'Begin the interview.' })
  return input
}
