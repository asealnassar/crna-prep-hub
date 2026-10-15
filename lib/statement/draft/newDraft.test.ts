import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TITLE_CHARS } from './validate.ts'
import { CREATE_MESSAGES } from './library.ts'
import { mayApplyPrompts } from './picker.ts'
import {
  NEW_DRAFT_MESSAGES,
  canCreateNow,
  createRequestFor,
  promptWasRefused,
  selectionAfterSchoolChange,
  canCreatePasteNow,
  newPastedDraftRequest,
  pasteIsComplete,
  stepBefore,
  stepForPath,
  type PastedPrompt,
  type CreatePath,
  type NewDraftStep,
} from './newDraft.ts'

const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'
const OTHER_PROMPT = 'c0ffee00-0000-4000-8000-000000000009'

const choice = (id: string) => ({
  id,
  label: 'Personal statement',
  promptText: 'Why have you chosen nurse anaesthesia?',
  statedMaxWords: 500,
  applicationCycle: '2026',
})

// ===========================================================================
// THE TWO PATHS
// ===========================================================================

test('the school path opens on the school screen, the general path on the title', () => {
  assert.equal(stepForPath('school'), 'school')
  assert.equal(stepForPath('general'), 'title')
})

test('neither path is ever a default: a path must be chosen before Create opens', () => {
  assert.equal(canCreateNow({
    path: null, title: 'A good title', promptId: PROMPT, submitting: false, retryable: true,
  }), false)
})

test('Back walks the school path screen by screen, and never past the first', () => {
  assert.equal(stepBefore('title', 'school'), 'prompt')
  assert.equal(stepBefore('prompt', 'school'), 'school')
  assert.equal(stepBefore('school', 'school'), 'choice')
  assert.equal(stepBefore('choice', 'school'), null, 'there is nowhere before the first screen')
})

test('Back from the general title screen skips the screens it never saw', () => {
  assert.equal(stepBefore('title', 'general'), 'choice')
  assert.equal(stepBefore('title', null), 'choice')
})

test('every screen has a defined answer, so Back can never be undefined', () => {
  const steps: NewDraftStep[] = ['choice', 'school', 'prompt', 'title']
  const paths: (CreatePath | null)[] = ['school', 'general', null]
  for (const step of steps) {
    for (const path of paths) {
      const before = stepBefore(step, path)
      assert.ok(before === null || steps.includes(before), `${step}/${path}`)
    }
  }
})

// ===========================================================================
// WHEN CREATE MAY FIRE
// ===========================================================================

test('the general path may create with only a title', () => {
  assert.equal(canCreateNow({
    path: 'general', title: 'My statement', promptId: null, submitting: false, retryable: true,
  }), true)
})

test('THE SCHOOL PATH MAY NOT CREATE WITHOUT A PROMPT', () => {
  // The accident this prevents: pressing Create on the school path with nothing
  // selected and being handed a blank general draft.
  for (const missing of [null, '', '   ', 'nope', `${PROMPT}x`]) {
    assert.equal(canCreateNow({
      path: 'school', title: 'My statement', promptId: missing, submitting: false, retryable: true,
    }), false, `${JSON.stringify(missing)} is not a prompt`)
  }
  assert.equal(canCreateNow({
    path: 'school', title: 'My statement', promptId: PROMPT, submitting: false, retryable: true,
  }), true)
})

test('a title that could not be saved never opens Create, on either path', () => {
  for (const path of ['school', 'general'] as const) {
    for (const bad of ['', '   ', '\t\n', 'x'.repeat(MAX_TITLE_CHARS + 1)]) {
      assert.equal(canCreateNow({
        path, title: bad, promptId: PROMPT, submitting: false, retryable: true,
      }), false, `${path}: ${JSON.stringify(bad.slice(0, 12))}`)
    }
  }
})

test('a request in flight, or one that may have left a draft, closes Create', () => {
  const base = { path: 'general' as const, title: 'A title', promptId: null }
  assert.equal(canCreateNow({ ...base, submitting: true, retryable: true }), false)
  assert.equal(canCreateNow({ ...base, submitting: false, retryable: false }), false)
  // Exact booleans only, matching canSubmitNewDraft.
  for (const notFalse of [undefined, null, 1, 'no']) {
    assert.equal(canCreateNow({
      ...base, submitting: notFalse as never, retryable: true,
    }), false)
  }
})

// ===========================================================================
// A PROMPT MAY NOT OUTLIVE ITS SCHOOL
// ===========================================================================

test('changing school clears a prompt that belonged to the previous one', () => {
  assert.equal(selectionAfterSchoolChange({
    chosenId: 'school-b', browsingId: 'school-a', prompt: choice(PROMPT),
  }), null)
})

test('re-choosing the SAME school keeps the prompt already selected', () => {
  // Going Back and clicking the same row is how somebody checks their choice.
  const prompt = choice(PROMPT)
  assert.equal(selectionAfterSchoolChange({
    chosenId: 'school-a', browsingId: 'school-a', prompt,
  }), prompt)
})

test('choosing the first school clears nothing, because there is nothing to clear', () => {
  assert.equal(selectionAfterSchoolChange({
    chosenId: 'school-a', browsingId: null, prompt: null,
  }), null)
  // And a prompt held with no school browsed is not a state to preserve.
  assert.equal(selectionAfterSchoolChange({
    chosenId: 'school-a', browsingId: null, prompt: choice(PROMPT),
  }), null)
})

test('the stale-response guard is the committed one, reused rather than rewritten', () => {
  // Rapid switching: two requests in the air, the first landing second.
  assert.equal(mayApplyPrompts({ requestedFor: 'school-a', browsingNow: 'school-a' }), true)
  assert.equal(mayApplyPrompts({ requestedFor: 'school-a', browsingNow: 'school-b' }), false)
  assert.equal(mayApplyPrompts({ requestedFor: 'school-a', browsingNow: null }), false)
})

// ===========================================================================
// WHAT IS SENT
// ===========================================================================

test('the general path sends exactly a title and an empty essay', () => {
  const request = createRequestFor({ path: 'general', title: '  My General Statement  ', promptId: null })
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok && request.body, { title: 'My General Statement', essay: '' })
})

test('the school path sends exactly a title, an empty essay and the prompt id', () => {
  const request = createRequestFor({ path: 'school', title: '  My School Statement  ', promptId: PROMPT })
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok && request.body, {
    title: 'My School Statement', essay: '', promptId: PROMPT,
  })
})

test('A GENERAL REQUEST NEVER CARRIES A PROMPT, even when one is in hand', () => {
  // Switching to the general path after choosing a prompt must send a general
  // body: the applicant chose to abandon the school, not to keep it silently.
  const request = createRequestFor({ path: 'general', title: 'A title', promptId: PROMPT })
  assert.equal(request.ok, true)
  assert.equal(request.ok && 'promptId' in request.body, false)
  assert.equal(JSON.stringify(request.ok && request.body).includes(PROMPT), false)
})

test('A SCHOOL REQUEST WITHOUT A PROMPT IS REFUSED, never downgraded to general', () => {
  // THE FALLBACK THAT MUST NOT EXIST. If this ever returned a two-key body, an
  // applicant on the school path would silently receive a blank statement.
  for (const missing of [null, '', 'nope', undefined as never]) {
    const request = createRequestFor({ path: 'school', title: 'A title', promptId: missing })
    assert.equal(request.ok, false, `${JSON.stringify(missing)} must be refused`)
    assert.equal(request.ok === false && request.message, CREATE_MESSAGES.promptUnusable)
  }
})

test('neither path can author canonical prompt values', () => {
  for (const path of ['school', 'general'] as const) {
    const request = createRequestFor({ path, title: 'A title', promptId: PROMPT })
    const sent = JSON.stringify(request.ok && request.body)
    for (const canonical of ['schoolId', 'school_id', 'promptText', 'prompt_text',
                             'statedMaxWords', 'stated_max_words']) {
      assert.equal(sent.includes(canonical), false, `${path} must not send ${canonical}`)
    }
  }
})

test('a bad title is refused identically on both paths', () => {
  for (const bad of ['', '   ', null, 42]) {
    const school = createRequestFor({ path: 'school', title: bad as never, promptId: PROMPT })
    const general = createRequestFor({ path: 'general', title: bad as never, promptId: null })
    assert.equal(school.ok, false)
    assert.equal(general.ok, false)
    assert.equal(school.ok === false && school.message, general.ok === false && general.message)
  }
})

// ===========================================================================
// A WITHDRAWN PROMPT
// ===========================================================================

test('a prompt refusal is recognised, and an ordinary one is not', () => {
  assert.equal(promptWasRefused(CREATE_MESSAGES.promptGone), true)
  assert.equal(promptWasRefused(CREATE_MESSAGES.promptUnusable), true)
  for (const other of [
    CREATE_MESSAGES.server, CREATE_MESSAGES.network, CREATE_MESSAGES.session,
    CREATE_MESSAGES.title, CREATE_MESSAGES.tooLong, CREATE_MESSAGES.unavailable,
    CREATE_MESSAGES.unopenable, '',
  ]) {
    assert.equal(promptWasRefused(other), false, other)
  }
})

test('the prompt messages are distinct, so the two cases are tellable apart', () => {
  assert.notEqual(CREATE_MESSAGES.promptGone, CREATE_MESSAGES.promptUnusable)
  assert.notEqual(CREATE_MESSAGES.promptGone, CREATE_MESSAGES.server)
})

// ===========================================================================
// THE WORDS
// ===========================================================================

test('every message is distinct, and none is empty', () => {
  const values = Object.values(NEW_DRAFT_MESSAGES)
  assert.equal(new Set(values).size, values.length, 'two identical notices are one state too few')
  for (const value of values) assert.ok(value.trim().length > 0)
})

test('the empty-catalog wording does not tell a reader a prompt is optional here', () => {
  // The picker's noPrompts ends "you can keep writing -- a prompt is optional",
  // which is true in the editor and false before anything exists.
  assert.equal(NEW_DRAFT_MESSAGES.noPrompts.includes('keep writing'), false)
  assert.ok(NEW_DRAFT_MESSAGES.startGeneral.length > 0, 'and there is a way forward')
})

// ===========================================================================
// THE PASTED PROMPT
// ===========================================================================

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'

const paste = (over: Partial<PastedPrompt> = {}): PastedPrompt => ({
  promptText: 'Describe a clinical experience that shaped you.',
  statedMaxWords: null,
  applicationCycle: null,
  sourceUrl: null,
  confirmed: true,
  ...over,
})

test('the paste screen sits under the prompt list, and Back returns there', () => {
  assert.equal(stepBefore('paste', 'school'), 'prompt')
  assert.equal(stepBefore('title', 'school'), 'prompt')
})

test('a paste needs wording and consent, and nothing else', () => {
  assert.equal(pasteIsComplete(paste()), true)
  // The three optional fields stay optional: a school often states none.
  assert.equal(pasteIsComplete(paste({ statedMaxWords: null, applicationCycle: null })), true)
  for (const incomplete of [
    paste({ promptText: '' }),
    paste({ promptText: '   ' }),
    paste({ confirmed: false }),
  ]) {
    assert.equal(pasteIsComplete(incomplete), false)
  }
  assert.equal(pasteIsComplete(null), false)
  assert.equal(pasteIsComplete(undefined), false)
})

test('CONSENT IS NOT IMPLIED by anything other than true', () => {
  for (const notTrue of [false, undefined, null, 'yes', 1]) {
    assert.equal(pasteIsComplete(paste({ confirmed: notTrue as never })), false)
  }
})

test('a pasted request nests everything under one key, and carries NO promptId', () => {
  const request = newPastedDraftRequest('  My Duke Statement  ', SCHOOL, paste({
    statedMaxWords: 500, applicationCycle: '2026', sourceUrl: 'https://example.edu/a',
  }))
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok && request.body, {
    title: 'My Duke Statement',
    essay: '',
    promptSubmission: {
      schoolId: SCHOOL,
      promptText: paste().promptText,
      statedMaxWords: 500,
      applicationCycle: '2026',
      sourceUrl: 'https://example.edu/a',
      confirmed: true,
      // 20261006_008. PRESENT AND null, never absent: JSON.stringify drops an
      // undefined value, and a key that is sometimes missing is a shape the
      // route would have to reason about twice.
      documentLabel: null,
      documentTypeHint: null,
      statedMinWords: null,
      statedMaxCharacters: null,
      statedMaxPages: null,
      statedPagesText: null,
      formattingInstructions: null,
      otherInstructions: null,
      submitterNote: null,
    },
  })
  // THE SHAPE IS THE SAFEGUARD: no promptId at any level, so this body cannot
  // be mistaken for one that names a catalog prompt.
  const sent = JSON.stringify(request.ok && request.body)
  assert.equal(sent.includes('promptId'), false)
})

test('a pasted request is refused without a school, wording or consent', () => {
  assert.equal(newPastedDraftRequest('A title', null, paste()).ok, false)
  assert.equal(newPastedDraftRequest('A title', 'nope', paste()).ok, false)
  assert.equal(newPastedDraftRequest('A title', SCHOOL, paste({ confirmed: false })).ok, false)
  assert.equal(newPastedDraftRequest('A title', SCHOOL, paste({ promptText: ' ' })).ok, false)
  assert.equal(newPastedDraftRequest('A title', SCHOOL, null).ok, false)
  // And the title is still refused first, as on every other path.
  const both = newPastedDraftRequest('   ', SCHOOL, paste({ confirmed: false }))
  assert.equal(both.ok === false && both.message, CREATE_MESSAGES.title)
})

test('a paste NEVER downgrades to a general or approved request', () => {
  // The refusal is a refusal. There is no fallback body on this path either.
  const refused = newPastedDraftRequest('A title', SCHOOL, paste({ confirmed: false }))
  assert.equal(refused.ok, false)
  assert.equal('body' in refused, false, 'a refusal carries no request to send')
})

test('Create for a paste needs a school, wording, consent and a title', () => {
  const base = { title: 'A title', schoolId: SCHOOL, submitting: false, retryable: true }
  assert.equal(canCreatePasteNow({ ...base, pasted: paste() }), true)
  assert.equal(canCreatePasteNow({ ...base, pasted: null }), false)
  assert.equal(canCreatePasteNow({ ...base, pasted: paste({ confirmed: false }) }), false)
  assert.equal(canCreatePasteNow({ ...base, schoolId: null, pasted: paste() }), false)
  assert.equal(canCreatePasteNow({ ...base, title: '  ', pasted: paste() }), false)
  assert.equal(canCreatePasteNow({ ...base, pasted: paste(), submitting: true }), false)
  assert.equal(canCreatePasteNow({ ...base, pasted: paste(), retryable: false }), false)
})

test('the committed school rule is UNCHANGED by pasting', () => {
  // canCreateNow still means what it meant: a school path with no catalog
  // prompt id may not create. A paste satisfies a different function.
  assert.equal(canCreateNow({
    path: 'school', title: 'A title', promptId: null, submitting: false, retryable: true,
  }), false)
})

test('the consent notice says both halves, and promises nothing about verification', () => {
  const notice = NEW_DRAFT_MESSAGES.pasteNotice
  assert.ok(notice.includes('reviewed by CRNAPREPHUB'))
  assert.ok(notice.includes('may be added'), 'may, not will')
  assert.ok(notice.includes('remain private'), 'the essay is never published')
  // It must not suggest the prompt has already been checked.
  assert.equal(/\bverified\b/i.test(notice), false)
  assert.ok(NEW_DRAFT_MESSAGES.unverifiedBadge.includes('Not yet verified'))
})
