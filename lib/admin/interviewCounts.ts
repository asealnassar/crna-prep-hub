/**
 * Interviews per user, for the admin analytics table.
 *
 * One interview is ONE interview_sessions row, however many questions it
 * asked. The table used to take the number of user_asked_questions rows
 * instead -- the interview page logs one of those per primary question -- so a
 * ten-question interview counted as ten interviews, and a five-question Quick
 * Mock would have counted as five.
 *
 * A session row is the right unit because nothing else adds one: resuming an
 * interview reuses its row, and a retried start reuses the row it already
 * created. Follow-ups are never logged as questions or as sessions.
 */
export function countInterviewsByUser(
  sessions: ReadonlyArray<{ user_id?: string | null }>
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const session of sessions) {
    const id = session?.user_id
    if (!id) continue
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}
