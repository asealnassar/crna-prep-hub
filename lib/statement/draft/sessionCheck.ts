import { createClient } from '../../supabase-browser.ts'

/**
 * Whether the browser still holds a session, asked only when a save has already
 * failed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EDITOR HAS TO ASK AT ALL
 * ---------------------------------------------------------------------------
 * The Studio gate answers an unadmitted caller with a 404 carrying a body that
 * deliberately says NOTHING -- not which endpoint refused them, not that a gate
 * exists, not that the draft does. That neutrality is the point: a blocked
 * caller must not be able to tell a hidden route from an absent one, and
 * studioGate.test.ts pins every word the body may not contain.
 *
 * So the server cannot tell the editor "your session expired" without giving up
 * the property it was built to have. The editor has to work it out locally.
 *
 * AND LOCALLY IT IS A CHEAP, CERTAIN QUESTION. The browser either holds a
 * session or it does not; nothing about the draft is involved, nothing is sent,
 * and no resource existence is revealed in either direction.
 *
 * ---------------------------------------------------------------------------
 * ASKED ON THE FAILURE PATH ONLY
 * ---------------------------------------------------------------------------
 * A successful save proves the session was good. This runs after a 404 has
 * already been mapped to "this draft no longer exists", to decide whether that
 * sentence is true -- so the ordinary path costs nothing.
 *
 * FAILS TOWARDS THE OLD BEHAVIOUR. If the client cannot be constructed or the
 * call throws, this returns true ("assume the session is fine"), leaving the
 * existing message in place. Guessing "expired" from a broken client would
 * send somebody to sign in again for no reason.
 */
export async function browserSessionAlive(): Promise<boolean> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase.auth.getSession()
    if (error) return true
    return data.session !== null
  } catch {
    return true
  }
}
