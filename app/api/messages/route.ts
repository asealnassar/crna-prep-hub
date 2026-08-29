import { NextRequest } from 'next/server'
import { handleMessageNotification } from '@/lib/messageNotify'

/**
 * Legacy duplicate of /api/messages/notify. No caller remains in the codebase
 * (verified by grep across app/, components/ and lib/), and since the
 * user_profiles lockdown its own anon-key lookup could no longer resolve a
 * recipient. It is kept, and routed through the same authorized handler, so
 * that anything still calling it in the wild is subject to identical checks
 * rather than the old unauthenticated path.
 */
export async function POST(request: NextRequest) {
  return handleMessageNotification(request)
}
