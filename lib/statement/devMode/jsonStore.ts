/**
 * Reading and writing the local review stores without losing them.
 *
 * ---------------------------------------------------------------------------
 * HOW A SAVED DRAFT DISAPPEARED
 * ---------------------------------------------------------------------------
 * Every store here was a JSON array read with
 *
 *     try { return JSON.parse(readFileSync(STORE)) } catch { return [] }
 *
 * and written with a plain `writeFileSync` of the whole array. Both halves are
 * reasonable alone and together they erase data:
 *
 *   1. writeFileSync TRUNCATES AND THEN WRITES. For the length of a large
 *      array there is a file on disk that is empty or half a document.
 *   2. A reader in that window gets a parse error, and the catch turns it into
 *      "there are no drafts".
 *   3. That caller then mutates its empty list and writes it back -- and every
 *      row that was not in its stale view is gone for good.
 *
 * A transient fault became permanent deletion, which is the one outcome a
 * store may never have. The applicant sees it as a draft that was saved,
 * confirmed saved, and then absent after logging back in.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT CLOSE IT
 * ---------------------------------------------------------------------------
 * WRITES ARE ATOMIC. The new contents go to a temporary file in the same
 * directory and are then renamed over the target. rename(2) is atomic within a
 * filesystem, so a reader sees either the whole previous file or the whole new
 * one, never a partial write. The window in rule 1 stops existing.
 *
 * AN UNREADABLE STORE IS AN ERROR, NOT AN EMPTY ONE. A file that is absent is
 * legitimately empty and still reads as []. A file that EXISTS and will not
 * parse throws, because the only safe thing to do with data you cannot read is
 * refuse to act as though it were not there. The request fails, loudly, and
 * the rows survive to be read again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Raised when a store exists but cannot be parsed. Never swallowed. */
export class LocalStoreUnreadable extends Error {
  readonly file: string
  constructor(file: string, cause: unknown) {
    super(
      `The local review store ${path.basename(file)} exists but could not be read. `
      + 'Refusing to treat it as empty, because the next write would erase it. '
      + `Inspect or delete the file by hand. (${String(cause)})`,
    )
    this.name = 'LocalStoreUnreadable'
    this.file = file
  }
}

/**
 * The store's contents, or `empty` when there is no store yet.
 *
 * THE DISTINCTION IS THE WHOLE POINT: "no file" and "a file I cannot read" are
 * different facts, and only the first one means there is nothing there.
 */
export function readJsonStore<T>(file: string, empty: T): T {
  if (!existsSync(file)) return empty
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    throw new LocalStoreUnreadable(file, cause)
  }
  // AN EMPTY FILE IS NOT CORRUPT. A store created and not yet written reads as
  // zero bytes, which is the same fact as no file at all.
  if (text.trim() === '') return empty
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new LocalStoreUnreadable(file, cause)
  }
}

/**
 * Replace the store's contents, atomically.
 *
 * SAME DIRECTORY, DELIBERATELY. rename is only atomic within one filesystem,
 * so the temporary file cannot live in the system temp directory.
 *
 * UNIQUE PER WRITE, so two writers never share a temporary name and clobber
 * each other's half-written file before either rename lands.
 */
export function writeJsonStore(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 1), 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    // A FAILED WRITE LEAVES THE PREVIOUS STORE INTACT, which is the point of
    // writing beside it. Clear the debris and let the caller see the failure.
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}
