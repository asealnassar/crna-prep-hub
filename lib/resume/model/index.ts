/**
 * The canonical Resume Builder V2 domain model.
 *
 * Everything here is pure: no Supabase, no network, no React, no clock and no
 * id generation. Ids and timestamps are parameters, so every function is
 * deterministic and testable without a database — the same discipline the
 * messaging and interview engines follow.
 *
 * This is the single data contract that later phases build on: the Studio,
 * autosave, AI co-writing, Resume Strength, the shared document renderer,
 * PDF, DOCX, import and the V1 migration.
 */

export * from './dates.ts'
export * from './authoredText.ts'
export * from './facts.ts'
export * from './types.ts'
export * from './sections.ts'
export * from './resume.ts'
export * from './v1Shapes.ts'
