/**
 * Whether an in-flight inbox read may still be applied.
 *
 * THE PROBLEM. `loadThreads()` resolves the signed-in user once, at the top,
 * and then spends seconds reading -- 8.86s measured against the admin inbox on
 * 2026-09-25. Nothing re-checks the session before it writes its result. If
 * the account changes during those seconds, the finished read belongs to the
 * PREVIOUS user and must be discarded, not rendered.
 *
 * TWO DISTINCT PATHS, and they fail differently:
 *
 *   1. SIGN OUT, THEN SIGN IN. MessagesModal is mounted only while a user
 *      exists, so signing out unmounts it. React discards `setThreads` on an
 *      unmounted component -- but `setGlobalMessagesUnreadCount` writes to the
 *      SidebarContext, which lives ABOVE the modal in SidebarProvider and does
 *      NOT unmount. So the previous account's unread COUNT could survive onto
 *      the next account's badge. `mounted` closes this.
 *
 *   2. A DIRECT SWITCH, with no signed-out state in between -- another tab
 *      signs in and this tab receives SIGNED_IN without SIGNED_OUT. The modal
 *      stays mounted, so every write lands, including the thread LIST.
 *      `sessionUserId` closes this.
 *
 * Neither path was introduced by the refresh scheduler; both predate it, and
 * the scheduler's in-flight guard already makes them rarer by ensuring only
 * one read is ever outstanding. This makes them impossible rather than rare.
 *
 * NO NETWORK. The caller supplies the live session id from a ref that the
 * component's existing onAuthStateChange listener already maintains, so this
 * check costs nothing -- which matters, because the whole point of the work
 * around it is to stop making requests we do not need.
 */

export type InboxResultContext = {
  /** Is the component that started the read still mounted? */
  readonly mounted: boolean
  /** The user id the read was started for. */
  readonly loadedFor: string
  /**
   * The live session's user id.
   *
   * `null` means signed out. `undefined` means the listener has not resolved
   * yet -- which cannot prove a mismatch, so it is treated as permission. That
   * window exists only between mount and the first auth resolution, during
   * which no account change can have happened.
   */
  readonly sessionUserId: string | null | undefined
}

export function mayApplyInboxResult(context: InboxResultContext): boolean {
  // Unmounted: nothing may be written, not even through a context that
  // outlived the component.
  if (!context.mounted) return false

  // Not yet resolved. No mismatch can be demonstrated, so allow it.
  if (context.sessionUserId === undefined) return true

  // Signed out (null), or signed in as somebody else.
  return context.sessionUserId === context.loadedFor
}
