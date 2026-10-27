import { createHash } from 'node:crypto'
import { RUBRIC_VERSION } from './rubric.ts'
import { REVIEW_SCHEMA_VERSION } from './reviewSchema.ts'
import type { RequirementSnapshot } from '../requirements/snapshot.ts'
// THE DIGEST MOVED OUT, and is shared with provenance checking so that "which
// fields of a requirement matter" has exactly one definition and cannot be
// extended in one place and forgotten in the other. It is pure string building
// with no node:crypto, which is what lets a browser-safe module compare two
// digests without pulling a Node builtin into the bundle.
import { requirementDigest } from '../requirements/digest.ts'

/**
 * SERVER ONLY. This module imports node:crypto.
 *
 * WHY IT IS ITS OWN FILE. It used to live in reviewAccess.ts beside the tier
 * check and the action labels -- which StatementStudioClient.tsx imports. A
 * client component pulls its whole import graph into the browser bundle, so one
 * `node:crypto` at the top of a shared module made Webpack try to resolve a
 * `node:` scheme it has no loader for, and the Statement Studio editor stopped
 * building. The error was a bundling failure, so neither tsc nor node --test
 * could see it: both resolve node: builtins perfectly well.
 *
 * NOTHING IN THIS FILE IS IMPORTED BY A CLIENT COMPONENT, and a test asserts
 * that by walking the editor's import graph rather than trusting the comment.
 *
 * THE FINGERPRINT STAYS SERVER-SIDE ANYWAY, which is why the split costs
 * nothing. It is computed from the SAVED draft -- the essay and prompt snapshot
 * as stored -- and compared against stored rows. A browser has neither, and a
 * browser-computed cache key would be a browser deciding whether work had
 * already been paid for.
 */

/**
 * What an analysis was actually about, as one value.
 *
 * THE INPUTS, AND ONLY THE INPUTS. An analysis is a function of the essay, the
 * question it answers, and the rubric used to judge it. Two drafts with the
 * same essay and the same prompt deserve the same feedback, and re-running the
 * model for one would be charging for work already done.
 *
 * THE TITLE IS DELIBERATELY ABSENT. Renaming a draft changes nothing a reviewer
 * would say about it, and including the title would make every rename a paid
 * call. The same reasoning excludes the revision number: a revision moves when
 * the title is saved, so it is a poor proxy for "the writing changed" -- which
 * is exactly why this is content-addressed rather than revision-addressed.
 *
 * THE VERSIONS ARE PART OF THE IDENTITY. A result produced under a different
 * rubric or a different output schema is not this result; changing either must
 * invalidate every cached analysis rather than serving feedback whose meaning
 * has shifted underneath it.
 *
 * NULL AND EMPTY STRING ARE DISTINGUISHED. The fields are joined with
 * separators that cannot occur in a uuid or in normal prose, so a draft whose
 * prompt is absent cannot collide with one whose prompt is an empty string, and
 * text cannot be moved across a field boundary to forge a match.
 */
export function analysisFingerprint(input: {
  readonly essay: string
  readonly promptText: string | null
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly statedMaxWords: number | null
  /**
   * The draft's STORED structured requirement, or null when it has none.
   *
   * PASS THE PARSED SNAPSHOT, NOT A LEGACY PROJECTION. snapshot.ts can build a
   * RequirementSnapshot out of an old draft's prompt columns, and that is the
   * right thing for the editor and the model prompt -- but it must NOT be
   * passed here. Appending a digest for a draft that has no stored requirement
   * would change its fingerprint, and every existing cached analysis would miss
   * and be paid for again. So the field is omitted for legacy drafts and the
   * value is then byte-identical to the one this function produced before
   * structured requirements existed. A test pins that equality.
   */
  readonly requirement?: RequirementSnapshot | null
  /**
   * Whether that requirement was authenticated against the catalog.
   *
   * PART OF THE KEY, AND IT HAS TO BE. The digest above covers the SNAPSHOT,
   * which is stored on the draft and does not move when the CATALOG moves. So
   * without this flag: a draft is analysed while its snapshot matches the
   * catalog and the result is stored claiming verified-school provenance; the
   * school then rewords its requirement; the next request computes the same
   * fingerprint, hits that stored row, and hands back a 'catalog' claim for a
   * requirement the catalog no longer publishes. Keying on the verdict gives
   * the authenticated and unauthenticated readings separate rows, so an
   * outdated or altered requirement cannot retrieve a result that vouches for
   * it.
   *
   * IGNORED WHEN THERE IS NO REQUIREMENT, so a legacy, pasted or general
   * draft's fingerprint is byte-identical to the one it has always had.
   */
  readonly requirementAuthentic?: boolean
}): string {
  const parts = [
    RUBRIC_VERSION,
    REVIEW_SCHEMA_VERSION,
    input.essay,
    input.promptText ?? '\u0000null',
    input.schoolId ?? '\u0000null',
    input.promptId ?? '\u0000null',
    input.statedMaxWords === null ? '\u0000null' : String(input.statedMaxWords),
  ]
  // APPENDED, NOT INTERLEAVED, and only when there is one. See the field notes.
  if (input.requirement !== undefined && input.requirement !== null) {
    parts.push(requirementDigest(input.requirement))
    // THE VERDICT IS ITS OWN PART, not folded into the digest, because the
    // digest describes the requirement and this describes our confidence in
    // it. Two facts, two fields.
    parts.push(`authentic:${input.requirementAuthentic === true}`)
  }
  return createHash('sha256').update(parts.join('\u0000\u0001'), 'utf8').digest('hex')
}
