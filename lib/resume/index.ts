/**
 * Resume Builder V2.
 *
 * `model/` is the canonical domain -- pure types and transitions, no I/O.
 * `repo/`  maps that domain to and from database rows, and decides whether a
 *          write may proceed. Its pure half is testable without a database;
 *          `resumeRepo.ts` is the thin Supabase shell over it.
 *
 * Nothing outside `repo/resumeRepo.ts` may talk to Supabase.
 */

export * from './model/index.ts'
export * from './repo/rows.ts'
export * from './repo/concurrency.ts'
