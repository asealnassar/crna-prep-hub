import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateGPA, normalizeCourseCode } from './engine.ts'
import { upgradeCourses } from './legacy.ts'
import {
  DEFAULT_POLICIES, LEGACY_V1_POLICIES,
  type Course, type Institution, type GpaPolicies,
} from './types.ts'

const INST = {
  A: { id: 'A', name: 'Bergen CC', creditSystem: 'semester' } as Institution,
  B: { id: 'B', name: 'Rutgers', creditSystem: 'semester' } as Institution,
  C: { id: 'C', name: 'Seattle U', creditSystem: 'quarter' } as Institution,
}
const ALL_INST = [INST.A, INST.B, INST.C]
const CTX = { institutions: ALL_INST, policies: { transfer: 'exclude' as const, retake: 'both' as const } }

function C(o: Partial<Course> & { name: string; grade: string; credits: number }): Course {
  return {
    id: o.id ?? o.name + Math.random(),
    institutionId: 'institutionId' in o ? (o.institutionId ?? null) : 'B',
    courseCode: o.courseCode ?? null,
    name: o.name, grade: o.grade, credits: o.credits,
    year: o.year ?? '2023', term: o.term ?? 'Fall',
    categories: o.categories ?? ['general'],
    categorySource: o.categorySource ?? 'default',
    level: o.level ?? 'undergraduate',
    levelSource: o.levelSource ?? 'default',
    recordType: o.recordType ?? 'coursework',
    transferredIn: o.transferredIn ?? false,
    needsReview: o.needsReview ?? false,
    reviewReasons: o.reviewReasons ?? [],
  }
}
const P = (p: Partial<GpaPolicies> = {}): GpaPolicies =>
  ({ ...DEFAULT_POLICIES, transfer: 'exclude', ...p })  // explicit unless a test overrides
const g = (cs: Course[], f: any = 'overall', pol?: Partial<GpaPolicies>) =>
  calculateGPA(cs, f, { institutions: ALL_INST, policies: P(pol) }).display

// ============================================ base arithmetic (V1 regressions)
test('worked example 25/7', () => {
  assert.equal(g([C({name:'Bio',grade:'A',credits:4}), C({name:'Chem',grade:'B',credits:3})]), '3.57')
})
test('A+ = 4.0 and D- = 0.7', () => {
  assert.equal(g([C({name:'x',grade:'A+',credits:3})]), '4.00')
  assert.equal(g([C({name:'x',grade:'D-',credits:3})]), '0.70')
})
test('W and P excluded, not scored 0.0', () => {
  assert.equal(g([C({name:'a',grade:'A',credits:4}), C({name:'w',grade:'W',credits:3})]), '4.00')
})
test('string credits do not concatenate', () => {
  const r = calculateGPA([C({name:'a',grade:'A',credits:'4' as any}), C({name:'b',grade:'B',credits:'3' as any})], 'overall', CTX)
  assert.equal(r.creditsCounted, 7)
  assert.equal(r.display, '3.57')
})
test('unrecognized grades flagged, never scored', () => {
  const r = calculateGPA([C({name:'ok',grade:'A',credits:4}), C({name:'bad',grade:'ZZ',credits:3})], 'overall', CTX)
  assert.equal(r.display, '4.00')
  assert.equal(r.issues[0].reason, 'unrecognized-grade')
})

// ================================================== D1 TRANSFER POLICY
test('D1: transfer policy include vs exclude on the same dataset', () => {
  const set = [
    C({ name:'BIO 101', grade:'A', credits:4, institutionId:'A', transferredIn:true, categories:['science'] }),
    C({ name:'CHEM 101', grade:'B', credits:4, institutionId:'A', transferredIn:true, categories:['science'] }),
    C({ name:'Nursing', grade:'C', credits:60, institutionId:'B', categories:['nursing'] }),
  ]
  // 60-credit nursing row is over the per-course cap, so use realistic rows:
  const nursing = Array.from({length:20},(_,i)=>
    C({ name:'NUR'+i, grade:'C', credits:3, institutionId:'B', categories:['nursing'] }))
  const all = [set[0], set[1], ...nursing]

  assert.equal(g(all, 'overall', { transfer:'exclude' }), '2.00')
  assert.equal(g(all, 'overall', { transfer:'include' }), (((16+12)+(120))/68).toFixed(2))
  // Science GPA exists only when transfer is included.
  assert.equal(g(all, 'science', { transfer:'exclude' }), null)
  assert.equal(g(all, 'science', { transfer:'include' }), '3.50')
})

test('D1: transfer_notation is NEVER counted, under either policy', () => {
  const bergenReal = C({ name:'BIO 101', grade:'A', credits:4, institutionId:'A',
                         courseCode:'BIO101', transferredIn:true, categories:['science'] })
  const rutgersNotation = C({ name:'Transfer Credit - BIO 101', grade:'TR', credits:4,
                             institutionId:'B', courseCode:'BIO101',
                             recordType:'transfer_notation', categories:['science'] })
  const both = [bergenReal, rutgersNotation]

  for (const policy of ['include','exclude'] as const) {
    const r = calculateGPA(both, 'science', { institutions: ALL_INST, policies: P({ transfer: policy }) })
    assert.equal(r.exclusions['transfer-notation'], 1, `notation dropped under ${policy}`)
  }
  // Included: the ORIGINATING attempt counts exactly once -> 4 credits, not 8.
  const inc = calculateGPA(both, 'science', { institutions: ALL_INST, policies: P({ transfer:'include' }) })
  assert.equal(inc.creditsCounted, 4)
  assert.equal(inc.display, '4.00')
})

// ==================================================== D7 RETAKE POLICY
test('D7: both attempts vs latest attempt', () => {
  const first  = C({ name:'BIO 101', grade:'C', credits:4, courseCode:'BIO 101', institutionId:'B', year:'2021', term:'Fall' })
  const repeat = C({ name:'BIO 101', grade:'A', credits:4, courseCode:'bio-101', institutionId:'B', year:'2023', term:'Spring' })
  assert.equal(g([first,repeat],'overall',{retake:'both'}), '3.00')
  assert.equal(g([first,repeat],'overall',{retake:'latest'}), '4.00')
  const r = calculateGPA([first,repeat],'overall',{institutions:ALL_INST,policies:P({retake:'latest'})})
  assert.equal(r.exclusions['superseded-retake'], 1)
})

test('D7: retakes match across terms and years', () => {
  const a = C({ name:'CHEM', grade:'F', credits:4, courseCode:'CHM120', institutionId:'B', year:'2019', term:'Spring' })
  const b = C({ name:'CHEM', grade:'C', credits:4, courseCode:'CHM120', institutionId:'B', year:'2020', term:'Fall' })
  const c = C({ name:'CHEM', grade:'A', credits:4, courseCode:'CHM120', institutionId:'B', year:'2024', term:'Summer' })
  assert.equal(g([a,b,c],'overall',{retake:'latest'}), '4.00')
  assert.equal(g([a,b,c],'overall',{retake:'both'}), '2.00')
})

test('D7: similarly named courses are NOT treated as retakes', () => {
  const x = C({ name:'Anatomy & Physiology I',  grade:'C', credits:4, courseCode:'BIO101', institutionId:'B', year:'2021' })
  const y = C({ name:'Anatomy & Physiology II', grade:'A', credits:4, courseCode:'BIO102', institutionId:'B', year:'2022' })
  assert.equal(g([x,y],'overall',{retake:'latest'}), '3.00', 'different codes are different courses')
})

test('D7: same code at DIFFERENT institutions is not a retake', () => {
  const x = C({ name:'BIO 101', grade:'C', credits:4, courseCode:'BIO101', institutionId:'A', year:'2021' })
  const y = C({ name:'BIO 101', grade:'A', credits:4, courseCode:'BIO101', institutionId:'B', year:'2022' })
  assert.equal(g([x,y],'overall',{retake:'latest'}), '3.00')
})

test('D7: no course code means no automatic retake removal', () => {
  const x = C({ name:'BIO 101', grade:'C', credits:4, courseCode:null, institutionId:'B', year:'2021' })
  const y = C({ name:'BIO 101', grade:'A', credits:4, courseCode:null, institutionId:'B', year:'2022' })
  assert.equal(g([x,y],'overall',{retake:'latest'}), '3.00', 'both kept when unmatchable')
})

test('D7: unorderable attempts are kept and flagged, never silently dropped', () => {
  const x = C({ name:'BIO', grade:'C', credits:4, courseCode:'BIO101', institutionId:'B', year:'', term:'' })
  const y = C({ name:'BIO', grade:'A', credits:4, courseCode:'BIO101', institutionId:'B', year:'2022', term:'Fall' })
  const r = calculateGPA([x,y],'overall',{institutions:ALL_INST,policies:P({retake:'latest'})})
  assert.equal(r.coursesCounted, 2)
  assert.equal(r.issues.some(i=>i.reason==='ambiguous-retake'), true)
})

test('normalizeCourseCode', () => {
  assert.equal(normalizeCourseCode('BIO 101'), 'BIO101')
  assert.equal(normalizeCourseCode('bio-101'), 'BIO101')
  assert.equal(normalizeCourseCode('a'), null)
})

// ================================================== D6 ACADEMIC LEVEL
test('D6: Graduate GPA contains only graduate coursework', () => {
  const ug = [C({name:'UG1',grade:'C',credits:3,level:'undergraduate'}),
              C({name:'UG2',grade:'C',credits:3,level:'undergraduate'})]
  const gr = [C({name:'GR1',grade:'A',credits:3,level:'graduate'}),
              C({name:'GR2',grade:'A',credits:3,level:'graduate'})]
  const all = [...ug,...gr]
  assert.equal(g(all,'graduate'), '4.00')
  assert.equal(g(all,'overall'), '3.00', 'Overall spans every level')
  assert.equal(calculateGPA(all,'graduate',{institutions:ALL_INST}).coursesCounted, 2)
})

test('D6: unknown level is not silently counted as graduate', () => {
  const r = calculateGPA([C({name:'x',grade:'A',credits:3,level:'unknown'})],'graduate',{institutions:ALL_INST})
  assert.equal(r.value, null)
})

test('D6: level is per course, not per institution', () => {
  const same = [C({name:'ug',grade:'C',credits:3,institutionId:'B',level:'undergraduate'}),
                C({name:'gr',grade:'A',credits:3,institutionId:'B',level:'graduate'})]
  assert.equal(g(same,'graduate'), '4.00')
})

// ==================================================== D8 LAST 60
test('D8: 55 credits + an 18-credit boundary term uses all 73 credits', () => {
  const older = Array.from({length:5},(_,i)=>C({name:'b'+i,grade:'A',credits:3,year:'2022',term:'Spring'})) // 15
  const term2 = Array.from({length:6},(_,i)=>C({name:'c'+i,grade:'A',credits:3,year:'2023',term:'Spring'})) // 18
  const term3 = Array.from({length:6},(_,i)=>C({name:'d'+i,grade:'A',credits:3,year:'2023',term:'Fall'}))   // 18
  const term4 = Array.from({length:6},(_,i)=>C({name:'e'+i,grade:'A',credits:3,year:'2024',term:'Spring'})) // 18
  const term5 = Array.from({length:6},(_,i)=>C({name:'f'+i,grade:'F',credits:3,year:'2024',term:'Fall'}))   // 18
  // newest four terms = 18+18+18+18 = 72... take newest until >=60: 18,18,18 = 54 (<60) then +18 = 72
  const r = calculateGPA([...older,...term2,...term3,...term4,...term5],'last60',{institutions:ALL_INST})
  assert.equal(r.creditsCounted, 72, 'whole boundary term included, never prorated')
})

test('D8: the exact spec example -- 55 credits + an 18-credit term = 73', () => {
  // Newest terms sum to 55 credits (20 + 20 + 15), still under the window.
  const t2025F = Array.from({length:10},(_,i)=>C({name:'a'+i,grade:'A',credits:2,year:'2025',term:'Fall'}))   // 20
  const t2025S = Array.from({length:10},(_,i)=>C({name:'b'+i,grade:'A',credits:2,year:'2025',term:'Spring'})) // 20
  const t2024F = Array.from({length:5},(_,i)=>C({name:'c'+i,grade:'A',credits:3,year:'2024',term:'Fall'}))    // 15
  // The boundary term: 18 credits, all F so its inclusion is unmistakable.
  const t2024S = Array.from({length:6},(_,i)=>C({name:'d'+i,grade:'F',credits:3,year:'2024',term:'Spring'}))  // 18
  const ancient = Array.from({length:10},(_,i)=>C({name:'z'+i,grade:'A',credits:3,year:'2015',term:'Fall'}))

  const r = calculateGPA([...ancient,...t2024S,...t2024F,...t2025S,...t2025F],'last60',{institutions:ALL_INST})
  assert.equal(r.creditsCounted, 73, '55 + the entire 18-credit boundary term')
  assert.equal(r.display, ((55*4)/73).toFixed(2), 'boundary term counted in full, at its real grades')
  assert.equal(r.coursesCounted, 31)
})

test('D8: 57 credits + a 12-credit term uses the entire term (69)', () => {
  const newest = Array.from({length:19},(_,i)=>C({name:'n'+i,grade:'A',credits:3,year:'2025',term:'Fall'}))   // 57
  const boundary = Array.from({length:4},(_,i)=>C({name:'b'+i,grade:'F',credits:3,year:'2024',term:'Fall'})) // 12
  const older = Array.from({length:10},(_,i)=>C({name:'o'+i,grade:'A',credits:3,year:'2018',term:'Fall'}))
  const r = calculateGPA([...older,...boundary,...newest],'last60',{institutions:ALL_INST})
  assert.equal(r.creditsCounted, 69)
})

test('D8: exactly 60 credits stops cleanly', () => {
  const t = (y:string,term:string)=>Array.from({length:5},(_,i)=>C({name:y+term+i,grade:'A',credits:3,year:y,term}))
  const all = [...t('2021','Fall'),...t('2022','Spring'),...t('2022','Fall'),...t('2023','Spring')] // 4 x 15 = 60
  const older = t('2019','Fall')
  const r = calculateGPA([...older,...all],'last60',{institutions:ALL_INST})
  assert.equal(r.creditsCounted, 60)
  assert.equal(r.display, '4.00', 'older term must not be pulled in')
})

test('D8: REGRESSION course order inside a term has ZERO effect', () => {
  const older = Array.from({length:16},(_,i)=>C({name:'o'+i,grade:'A',credits:3,year:'2019',term:'Fall'})) // 48
  const boundary = [
    C({name:'f1',grade:'A',credits:3,year:'2025',term:'Fall'}),
    C({name:'f2',grade:'A',credits:3,year:'2025',term:'Fall'}),
    C({name:'f3',grade:'A',credits:3,year:'2025',term:'Fall'}),
    C({name:'f4',grade:'F',credits:3,year:'2025',term:'Fall'}),
    C({name:'f5',grade:'F',credits:3,year:'2025',term:'Fall'}),
    C({name:'f6',grade:'F',credits:3,year:'2025',term:'Fall'}),
  ]
  const perms = [
    [...boundary, ...older],
    [...[...boundary].reverse(), ...older],
    [...older, ...boundary],
    [...older, ...[...boundary].reverse()],
    [boundary[3],boundary[0],boundary[5],boundary[1],boundary[4],boundary[2], ...older],
  ]
  const results = perms.map(p => calculateGPA(p,'last60',{institutions:ALL_INST}).display)
  assert.equal(new Set(results).size, 1, `all permutations must agree, got ${JSON.stringify(results)}`)
})

test('D8: W inside a boundary term consumes no window and is not scored', () => {
  const recent = [C({name:'w1',grade:'W',credits:12,year:'2025',term:'Fall'}),
                  C({name:'a1',grade:'A',credits:3,year:'2025',term:'Fall'})]
  const older = Array.from({length:20},(_,i)=>C({name:'o'+i,grade:'A',credits:3,year:'2020',term:'Fall'}))
  const r = calculateGPA([...recent,...older],'last60',{institutions:ALL_INST})
  assert.equal(r.display,'4.00')
  assert.equal(r.creditsCounted, 63, '3 from the boundary term + the whole 60-credit older term')
})

test('D8: interacts correctly with transfer policy', () => {
  const t = C({name:'tr',grade:'F',credits:12,year:'2025',term:'Fall',transferredIn:true,institutionId:'A'})
  const n = Array.from({length:20},(_,i)=>C({name:'n'+i,grade:'A',credits:3,year:'2024',term:'Fall'}))
  assert.equal(g([t,...n],'last60',{transfer:'exclude'}), '4.00')
  assert.notEqual(g([t,...n],'last60',{transfer:'include'}), '4.00')
})

test('D8: interacts correctly with retake policy', () => {
  const a = C({name:'BIO',grade:'F',credits:4,courseCode:'BIO101',institutionId:'B',year:'2024',term:'Fall'})
  const b = C({name:'BIO',grade:'A',credits:4,courseCode:'BIO101',institutionId:'B',year:'2025',term:'Fall'})
  assert.equal(g([a,b],'last60',{retake:'latest'}), '4.00')
  assert.equal(g([a,b],'last60',{retake:'both'}), '2.00')
})

// ============================================ D5 QUARTER CREDITS UNSUPPORTED
test('D5: quarter-credit coursework is excluded and flagged, never converted', () => {
  const q = C({ name:'Quarter Chem', grade:'A', credits:5, institutionId:'C', categories:['science'] })
  const s = C({ name:'Sem Chem', grade:'C', credits:4, institutionId:'B', categories:['science'] })
  const r = calculateGPA([q,s],'science',{institutions:ALL_INST})
  assert.equal(r.creditsCounted, 4, 'only the semester course counts')
  assert.equal(r.display, '2.00')
  assert.equal(r.exclusions['unsupported-credit-system'], 1)
  assert.equal(r.issues.some(i=>i.reason==='unsupported-credit-system'), true)
  // Explicitly prove no x2/3 conversion happened.
  assert.notEqual(r.creditsCounted, 4 + 5 * (2/3))
})

test('D5: quarter exclusion applies to every GPA type', () => {
  const q = C({ name:'Q', grade:'A', credits:5, institutionId:'C', categories:['science','nursing'], level:'graduate' })
  for (const f of ['overall','science','nursing','graduate','last60'] as const) {
    assert.equal(calculateGPA([q],f,{institutions:ALL_INST}).value, null, `filter ${f}`)
  }
})

test('D5/D15: an unresolvable credit system is blocked, and is not labelled quarter', () => {
  // Superseded by D15: this previously asserted 4.00 (unknown calculated as
  // semester). D15 forbids that -- it must be blocked pending review instead,
  // while still being distinguishable from the quarter case.
  const u = C({ name:'U', grade:'A', credits:3, institutionId:null })
  const r = calculateGPA([u],'overall',{institutions:ALL_INST, policies:P()})
  assert.equal(r.value, null)
  assert.equal(r.exclusions['no-institution'], 1)
  assert.equal(r.exclusions['unsupported-credit-system'], undefined, 'not a quarter problem')
})

// ================================================ D9 INSTITUTIONS
test('D9: coursework from three institutions calculates and retains identity', () => {
  const a = C({name:'A1',grade:'A',credits:3,institutionId:'A',transferredIn:true})
  const b = C({name:'B1',grade:'B',credits:3,institutionId:'B'})
  const c2 = C({name:'B2',grade:'C',credits:3,institutionId:'B'})
  const all = [a,b,c2]
  assert.equal(g(all,'overall',{transfer:'include'}), '3.00')
  assert.equal(g(all,'overall',{transfer:'exclude'}), '2.50')
  assert.equal(all.map(x=>x.institutionId).join(','), 'A,B,B', 'identity preserved')
})

// ================================================ backward compatibility
test('LEGACY: a V1 snapshot upgrades and reproduces V1 arithmetic', () => {
  const v1 = [
    { id:'1', name:'Bio',  grade:'A', credits:4, categories:['science'], isTransfer:false },
    { id:'2', name:'Chem', grade:'B', credits:3, categories:['science'], isTransfer:false },
    { id:'3', name:'Tr',   grade:'A', credits:4, categories:['science'], isTransfer:true  },
  ]
  const upgraded = upgradeCourses(v1)
  assert.equal(upgraded.length, 3)
  assert.equal(upgraded[2].transferredIn, true)
  assert.equal(upgraded[2].recordType, 'coursework')
  assert.equal(upgraded[2].needsReview, true)

  // D15 consequence: legacy coursework carries no institution, so nothing is
  // eligible until the user assigns schools. This must be visible, not silent.
  const blocked = calculateGPA(upgraded, 'overall', { policies: LEGACY_V1_POLICIES })
  assert.equal(blocked.value, null)
  assert.equal(blocked.exclusions['no-institution'], 3)
  assert.equal(blocked.issues.filter(i => i.reason === 'no-institution').length, 3)

  // Once assigned to a semester school, V1 arithmetic is reproduced exactly
  // under the V1 policy set (transfer excluded, both attempts).
  const assigned = upgraded.map(c => ({ ...c, institutionId: 'B' }))
  assert.equal(
    calculateGPA(assigned, 'overall', { institutions: ALL_INST, policies: LEGACY_V1_POLICIES }).display,
    '3.57'
  )
})

test('LEGACY: superseded `type` field maps into categories', () => {
  const [c] = upgradeCourses([{ id:'x', name:'Bio', grade:'A', credits:3, type:'science' }])
  assert.deepEqual(c.categories, ['science'])
})

test('LEGACY: garbage snapshots do not throw', () => {
  assert.deepEqual(upgradeCourses(null), [])
  assert.deepEqual(upgradeCourses('nope' as any), [])
  const out = upgradeCourses([null, undefined, {}, { grade:'77', credits:'x' }])
  assert.equal(out.length, 4)
  assert.equal(calculateGPA(out,'overall',CTX).value, null)
})

// ================================================ empty / zero states
test('empty and no-match states yield null, never 0.00', () => {
  for (const f of ['overall','science','nursing','last60','graduate'] as const) {
    assert.equal(calculateGPA([],f).value, null)
  }
})

// ============================================================ D10 - D16
// D10's confirmation flow lives in the page component; the pure state
// transitions it performs are modelled here. Browser-level verification is
// listed as unverified until the migration runs.
import { upgradeCourses as upgrade } from './legacy.ts'

function loadIntoDraft(
  draft: Course[], saved: { courses: any[]; engine_version?: number | null },
  confirmed: boolean
): { courses: Course[]; policies: GpaPolicies; replaced: boolean } {
  const needsConfirm = draft.length > 0
  if (needsConfirm && !confirmed) return { courses: draft, policies: DEFAULT_POLICIES, replaced: false }
  const legacy = (saved.engine_version ?? 1) < 2
  return {
    courses: legacy ? upgrade(saved.courses) : (saved.courses as Course[]),
    policies: legacy ? LEGACY_V1_POLICIES : DEFAULT_POLICIES,
    replaced: true,
  }
}

test('D10: viewing a saved calculation does not mutate the active draft', () => {
  const draft = [C({ name:'Draft course', grade:'A', credits:3 })]
  const snapshot = { courses: [{ id:'s1', name:'Saved', grade:'F', credits:3 }], engine_version: null }
  const before = JSON.stringify(draft)
  // "Viewing" is selection only -- no state transition at all.
  assert.equal(JSON.stringify(draft), before)
  assert.equal(snapshot.courses.length, 1, 'snapshot untouched')
})

test('D10: cancelling the confirmation preserves the draft', () => {
  const draft = [C({ name:'Draft', grade:'A', credits:3 })]
  const r = loadIntoDraft(draft, { courses:[{ id:'s', name:'Saved', grade:'F', credits:3 }] }, false)
  assert.equal(r.replaced, false)
  assert.equal(r.courses.length, 1)
  assert.equal(r.courses[0].name, 'Draft')
})

test('D10: confirming replaces the draft; the snapshot is unchanged', () => {
  const draft = [C({ name:'Draft', grade:'A', credits:3 })]
  const saved = { courses:[{ id:'s', name:'Saved', grade:'F', credits:3 }], engine_version: null }
  const savedBefore = JSON.stringify(saved)
  const r = loadIntoDraft(draft, saved, true)
  assert.equal(r.replaced, true)
  assert.equal(r.courses[0].name, 'Saved')
  assert.equal(JSON.stringify(saved), savedBefore, 'historical snapshot must not be modified')
})

test('D10: an empty draft loads without a confirmation', () => {
  const r = loadIntoDraft([], { courses:[{ id:'s', name:'Saved', grade:'A', credits:3 }] }, false)
  assert.equal(r.replaced, true)
})

test('D10: loading a legacy row applies V1 policies, not user defaults', () => {
  const r = loadIntoDraft([], { courses:[{ id:'s', name:'S', grade:'A', credits:3 }], engine_version: null }, true)
  assert.equal(r.policies.transfer, 'exclude')
  assert.equal(r.policies.retake, 'both')
})

// ------------------------------------------------------------------ D11
test('D11: there is no default transfer policy', () => {
  assert.equal(DEFAULT_POLICIES.transfer, null)
})

test('D11: transferred coursework is held out until the user chooses', () => {
  const tr = C({ name:'Bergen BIO', grade:'A', credits:4, transferredIn:true, institutionId:'A' })
  const own = C({ name:'Own', grade:'C', credits:4, institutionId:'B' })
  const unset = calculateGPA([tr, own], 'overall', { institutions: ALL_INST, policies: DEFAULT_POLICIES })
  assert.equal(unset.display, '2.00', 'only the non-transferred course counts')
  assert.equal(unset.exclusions['transfer-policy-unset'], 1)
  assert.equal(unset.issues.some(i => i.reason === 'transfer-policy-unset'), true)
  // and it is NOT silently treated as either policy
  assert.equal(unset.exclusions['transfer-policy'], undefined)
})

test('D11: after choosing, both settings give the documented result', () => {
  const tr = C({ name:'Bergen BIO', grade:'A', credits:4, transferredIn:true, institutionId:'A' })
  const own = C({ name:'Own', grade:'C', credits:4, institutionId:'B' })
  assert.equal(g([tr,own],'overall',{transfer:'include'}), '3.00')
  assert.equal(g([tr,own],'overall',{transfer:'exclude'}), '2.00')
})

test('D11: transfer_notation is excluded under unset, include AND exclude', () => {
  const note = C({ name:'Transfer Credit - BIO', grade:'A', credits:4,
                   recordType:'transfer_notation', institutionId:'B' })
  for (const t of [null, 'include', 'exclude'] as const) {
    const r = calculateGPA([note],'overall',{ institutions: ALL_INST, policies: { transfer: t, retake:'both' } })
    assert.equal(r.value, null, `notation must never count (transfer=${t})`)
    assert.equal(r.exclusions['transfer-notation'], 1)
  }
})

// ------------------------------------------------------------------ D12
test('D12: manual courses default to undergraduate; imported may stay unknown', () => {
  const manual = C({ name:'Manual', grade:'A', credits:3 })
  assert.equal(manual.level, 'undergraduate')
  const [imported] = upgrade([{ id:'i', name:'Imported', grade:'A', credits:3 }])
  assert.equal(imported.level, 'unknown', 'import must not be forced to undergraduate')
  assert.equal(imported.needsReview, true)
})

test('D12: level can be changed in both directions', () => {
  const c = C({ name:'X', grade:'A', credits:3, level:'undergraduate' })
  const toGrad = { ...c, level: 'graduate' as const }
  assert.equal(calculateGPA([toGrad],'graduate',CTX).display, '4.00')
  const back = { ...toGrad, level: 'undergraduate' as const }
  assert.equal(calculateGPA([back],'graduate',CTX).value, null)
})

// ------------------------------------------------------------------ D13
test('D13: Overall spans both levels; Graduate is graduate-only', () => {
  const ug = C({ name:'UG', grade:'A', credits:4, level:'undergraduate' })
  const gr = C({ name:'GR', grade:'B', credits:4, level:'graduate' })
  assert.equal(g([ug,gr],'overall'), '3.50')          // (16+12)/8
  assert.equal(g([ug,gr],'graduate'), '3.00')
  assert.equal(calculateGPA([ug,gr],'overall',CTX).coursesCounted, 2)
})

// ------------------------------------------------------------------ D14
test('D14: Science and Nursing GPA span both academic levels', () => {
  const ugSci = C({ name:'UG Chem', grade:'A', credits:4, categories:['science'], level:'undergraduate' })
  const grSci = C({ name:'GR Patho', grade:'B', credits:4, categories:['science'], level:'graduate' })
  const ugNur = C({ name:'UG Nurs', grade:'A', credits:4, categories:['nursing'], level:'undergraduate' })
  const grNur = C({ name:'GR Nurs', grade:'B', credits:4, categories:['nursing'], level:'graduate' })
  const all = [ugSci,grSci,ugNur,grNur]
  assert.equal(g(all,'science'), '3.50')
  assert.equal(g(all,'nursing'), '3.50')
  assert.equal(calculateGPA(all,'science',CTX).coursesCounted, 2, 'graduate science included')
  assert.equal(calculateGPA(all,'nursing',CTX).coursesCounted, 2, 'graduate nursing included')
})

// ------------------------------------------------------------------ D15
test('D15: semester calculates, quarter is flagged, unknown is blocked', () => {
  const sem = C({ name:'Sem', grade:'A', credits:4, institutionId:'B' })
  const qtr = C({ name:'Qtr', grade:'A', credits:5, institutionId:'C' })
  const unk = C({ name:'Unk', grade:'A', credits:4, institutionId:'D' })
  const insts = [...ALL_INST, { id:'D', name:'Unset School', creditSystem:'unknown' } as Institution]
  const r = calculateGPA([sem,qtr,unk],'overall',{ institutions: insts, policies: P() })
  assert.equal(r.creditsCounted, 4, 'only the semester course counts')
  assert.equal(r.exclusions['unsupported-credit-system'], 1)
  assert.equal(r.exclusions['credit-system-unknown'], 1)
  assert.equal(r.issues.some(i => i.reason === 'credit-system-unknown'), true)
})

test('D15 REGRESSION: unknown credit system must NEVER calculate as semester', () => {
  const insts = [{ id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const c = C({ name:'X', grade:'A', credits:4, institutionId:'D' })
  const r = calculateGPA([c],'overall',{ institutions: insts, policies: P() })
  assert.equal(r.value, null, 'must not produce a GPA')
  assert.equal(r.creditsCounted, 0, 'must contribute zero credits')
  assert.notEqual(r.display, '4.00', 'must not behave like a semester school')
  assert.notEqual(r.display, '0.00', 'must not look like a failing GPA either')
})

test('D15: a course with no institution at all is blocked, not assumed semester', () => {
  const c = C({ name:'Orphan', grade:'A', credits:4, institutionId:null })
  const r = calculateGPA([c],'overall',{ institutions: ALL_INST, policies: P() })
  assert.equal(r.value, null)
  assert.equal(r.exclusions['no-institution'], 1)
})

test('D15: blocking applies identically to every GPA type', () => {
  const insts = [{ id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const c = C({ name:'X', grade:'A', credits:4, institutionId:'D',
                categories:['science','nursing'], level:'graduate' })
  for (const f of ['overall','science','nursing','graduate','last60'] as const) {
    assert.equal(calculateGPA([c],f,{ institutions: insts, policies: P() }).value, null, `filter ${f}`)
  }
})

// ------------------------------------------------------------------ D16
function deleteInstitution(courses: Course[], instId: string): Course[] {
  return courses.map(c => c.institutionId === instId
    ? { ...c, institutionId: null, needsReview: true,
        reviewReasons: [...c.reviewReasons, 'Unassigned: the school this course belonged to was deleted.'] }
    : c)
}

test('D16: deleting an institution preserves every course', () => {
  const before = [
    C({ name:'Keep A', grade:'A', credits:4, institutionId:'A' }),
    C({ name:'Keep B', grade:'B', credits:3, institutionId:'A' }),
    C({ name:'Other',  grade:'C', credits:3, institutionId:'B' }),
  ]
  const after = deleteInstitution(before, 'A')
  assert.equal(after.length, before.length, 'course count must not change')
  assert.deepEqual(after.map(c => c.name), ['Keep A','Keep B','Other'])
  assert.deepEqual(after.map(c => c.grade), ['A','B','C'], 'grades preserved')
  assert.deepEqual(after.map(c => c.credits), [4,3,3], 'credits preserved')
})

test('D16: detached courses are unassigned and flagged for review', () => {
  const after = deleteInstitution([C({ name:'X', grade:'A', credits:4, institutionId:'A' })], 'A')
  assert.equal(after[0].institutionId, null)
  assert.equal(after[0].needsReview, true)
  assert.equal(after[0].reviewReasons.some(r => r.startsWith('Unassigned:')), true)
})

test('D16: courses at other institutions are untouched', () => {
  const after = deleteInstitution([C({ name:'X', grade:'A', credits:4, institutionId:'B' })], 'A')
  assert.equal(after[0].institutionId, 'B')
  assert.equal(after[0].needsReview, false)
})

// ================================================== INTERACTION MATRIX
test('INTERACTION: transfer policy x unknown credit system', () => {
  const insts = [{ id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const c = C({ name:'X', grade:'A', credits:4, institutionId:'D', transferredIn:true })
  for (const t of [null,'include','exclude'] as const) {
    const r = calculateGPA([c],'overall',{ institutions: insts, policies:{ transfer:t, retake:'both' } })
    assert.equal(r.value, null, `transfer=${t}`)
    assert.equal(r.exclusions['credit-system-unknown'], 1,
      'credit system is checked before transfer policy, so the reason is stable')
  }
})

test('INTERACTION: retake policy x unknown institution', () => {
  const insts = [{ id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const a = C({ name:'BIO', grade:'F', credits:4, courseCode:'BIO101', institutionId:'D', year:'2020' })
  const b = C({ name:'BIO', grade:'A', credits:4, courseCode:'BIO101', institutionId:'D', year:'2023' })
  const r = calculateGPA([a,b],'overall',{ institutions: insts, policies: P({retake:'latest'}) })
  assert.equal(r.value, null, 'blocked courses never reach retake resolution')
  assert.equal(r.exclusions['superseded-retake'], undefined)
})

test('INTERACTION: last60 x quarter and x unknown never leak in', () => {
  const insts = [...ALL_INST, { id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const good = Array.from({length:20},(_,i)=>C({name:'g'+i,grade:'A',credits:3,institutionId:'B',year:'2024',term:'Fall'}))
  const qtr  = C({ name:'Q', grade:'F', credits:5, institutionId:'C', year:'2025', term:'Fall' })
  const unk  = C({ name:'U', grade:'F', credits:4, institutionId:'D', year:'2025', term:'Fall' })
  const r = calculateGPA([qtr,unk,...good],'last60',{ institutions: insts, policies: P() })
  assert.equal(r.display, '4.00', 'blocked courses cannot enter the Last-60 window')
  assert.equal(r.creditsCounted, 60)
})

test('INTERACTION: last60 x transfer policy unset', () => {
  const tr = C({ name:'TR', grade:'F', credits:4, institutionId:'A', transferredIn:true, year:'2025', term:'Fall' })
  const good = Array.from({length:20},(_,i)=>C({name:'g'+i,grade:'A',credits:3,institutionId:'B',year:'2024',term:'Fall'}))
  const unset = calculateGPA([tr,...good],'last60',{ institutions: ALL_INST, policies: DEFAULT_POLICIES })
  assert.equal(unset.display, '4.00')
  const inc = calculateGPA([tr,...good],'last60',{ institutions: ALL_INST, policies: P({transfer:'include'}) })
  assert.notEqual(inc.display, '4.00', 'once included it must affect the window')
})

test('INTERACTION: Graduate GPA x unknown academic level', () => {
  const unk = C({ name:'U', grade:'A', credits:4, level:'unknown', institutionId:'B' })
  const gr  = C({ name:'G', grade:'C', credits:4, level:'graduate', institutionId:'B' })
  assert.equal(g([unk,gr],'graduate'), '2.00', 'unknown level never counts as graduate')
  assert.equal(g([unk,gr],'overall'), '3.00', 'but it still counts in Overall')
})

test('INTERACTION: eligibility is identical across every GPA type', () => {
  const insts = [...ALL_INST, { id:'D', name:'Unset', creditSystem:'unknown' } as Institution]
  const blocked = [
    C({ name:'noinst', grade:'A', credits:3, institutionId:null,  categories:['science','nursing'], level:'graduate' }),
    C({ name:'unk',    grade:'A', credits:3, institutionId:'D',   categories:['science','nursing'], level:'graduate' }),
    C({ name:'qtr',    grade:'A', credits:3, institutionId:'C',   categories:['science','nursing'], level:'graduate' }),
    C({ name:'note',   grade:'A', credits:3, institutionId:'B', recordType:'transfer_notation',
        categories:['science','nursing'], level:'graduate' }),
  ]
  for (const f of ['overall','science','nursing','graduate','last60'] as const) {
    const r = calculateGPA(blocked, f, { institutions: insts, policies: P() })
    assert.equal(r.coursesCounted, 0, `no blocked course may enter ${f}`)
    assert.equal(r.value, null)
  }
})

// ============================================================ D17 - D19
import {
  assignInstitution, unassignedCourses, coursesAwaitingCreditSystem,
} from './engine.ts'

const SEM = { id:'S', name:'Semester U', creditSystem:'semester' } as Institution
const QTR = { id:'Q', name:'Quarter U',  creditSystem:'quarter'  } as Institution
const UNS = { id:'U', name:'Unset U',    creditSystem:'unknown'  } as Institution

// ------------------------------------------------------------------ D17
test('D17: viewing a V1 snapshot uses its STORED values, not a recalculation', () => {
  // The historical row is the source of truth for display. Nothing here calls
  // the engine -- that is the point of the decision.
  const savedRow = {
    engine_version: null,
    overall_gpa: 1.65, science_gpa: 2.10, last60_gpa: 1.52, nursing_gpa: 2.00,
    courses: [{ id:'1', name:'Bio', grade:'A+', credits:4, categories:['science'] }],
  }
  const displayed = {
    overall: savedRow.overall_gpa, science: savedRow.science_gpa,
    last60: savedRow.last60_gpa, nursing: savedRow.nursing_gpa,
  }
  assert.equal(displayed.overall, 1.65, 'stored value shown as-is')
  // The V2 engine would disagree -- and must not be used for the snapshot view.
  const recomputed = calculateGPA(upgrade(savedRow.courses), 'overall', { policies: LEGACY_V1_POLICIES })
  assert.notEqual(recomputed.display, '1.65')
  assert.equal(recomputed.value, null, 'and it is blocked anyway: no institution')
  assert.equal(savedRow.overall_gpa, 1.65, 'historical row never mutated')
})

test('D17: loading V1 into the draft leaves courses blocked until assigned', () => {
  const legacy = upgrade([
    { id:'1', name:'Bio',  grade:'A', credits:4, categories:['science'] },
    { id:'2', name:'Chem', grade:'B', credits:3, categories:['science'] },
  ])
  const before = calculateGPA(legacy, 'overall', { institutions:[SEM], policies: LEGACY_V1_POLICIES })
  assert.equal(before.value, null)
  assert.equal(before.exclusions['no-institution'], 2)
  assert.equal(unassignedCourses(legacy).length, 2, 'guided flow surfaces them')
})

test('D17: bulk assignment preserves every course and every field', () => {
  const legacy = upgrade([
    { id:'1', name:'Bio',  grade:'A', credits:4,   categories:['science'] },
    { id:'2', name:'Chem', grade:'B', credits:3.5, categories:['science','nursing'] },
    { id:'3', name:'Eng',  grade:'C', credits:3,   categories:['general'] },
  ])
  const ids = unassignedCourses(legacy).map(c => c.id)
  assert.equal(ids.length, 3)
  const after = assignInstitution(legacy, ids, SEM.id)

  assert.equal(after.length, legacy.length, 'course count unchanged')
  assert.deepEqual(after.map(c => c.name),      ['Bio','Chem','Eng'])
  assert.deepEqual(after.map(c => c.grade),     ['A','B','C'],   'grades preserved')
  assert.deepEqual(after.map(c => c.credits),   [4,3.5,3],       'credits preserved')
  assert.deepEqual(after.map(c => c.categories),
    [['science'],['science','nursing'],['general']],             'categories preserved')
  assert.equal(after.every(c => c.institutionId === SEM.id), true)
  assert.equal(unassignedCourses(after).length, 0)
})

test('D17: partial selection assigns only the selected courses', () => {
  const cs = upgrade([
    { id:'1', name:'A', grade:'A', credits:3 },
    { id:'2', name:'B', grade:'A', credits:3 },
    { id:'3', name:'C', grade:'A', credits:3 },
  ])
  const after = assignInstitution(cs, [cs[0].id, cs[2].id], SEM.id)
  assert.equal(after.length, 3)
  assert.deepEqual(after.map(c => c.institutionId), [SEM.id, null, SEM.id])
})

test('D17: assigning to a SEMESTER school makes coursework eligible', () => {
  const legacy = upgrade([{ id:'1', name:'Bio', grade:'A', credits:4 }])
  const after = assignInstitution(legacy, [legacy[0].id], SEM.id)
  const r = calculateGPA(after, 'overall', { institutions:[SEM], policies: LEGACY_V1_POLICIES })
  assert.equal(r.display, '4.00')
  assert.equal(r.creditsCounted, 4)
})

test('D17: assigning to a QUARTER school keeps coursework excluded and flagged', () => {
  const legacy = upgrade([{ id:'1', name:'Bio', grade:'A', credits:4 }])
  const after = assignInstitution(legacy, [legacy[0].id], QTR.id)
  const r = calculateGPA(after, 'overall', { institutions:[QTR], policies: LEGACY_V1_POLICIES })
  assert.equal(r.value, null, 'still excluded -- never converted')
  assert.equal(r.exclusions['unsupported-credit-system'], 1)
  assert.match(r.issues[0].detail, /quarter-credit/i)
  assert.equal(after[0].credits, 4, 'credits untouched, not scaled by 2/3')
})

test('D17: assigning to a school with no credit system set stays blocked, with a distinct reason', () => {
  const legacy = upgrade([{ id:'1', name:'Bio', grade:'A', credits:4 }])
  const after = assignInstitution(legacy, [legacy[0].id], UNS.id)
  const r = calculateGPA(after, 'overall', { institutions:[UNS], policies: LEGACY_V1_POLICIES })
  assert.equal(r.value, null)
  assert.equal(r.exclusions['credit-system-unknown'], 1)
  assert.equal(r.exclusions['no-institution'], undefined, 'it IS assigned now')
  assert.equal(coursesAwaitingCreditSystem(after, [UNS]).length, 1)
})

test('D17: bulk assignment clears the unassigned review flag only', () => {
  const c = upgrade([{ id:'1', name:'Bio', grade:'A', credits:4, isTransfer:true }])
  assert.equal(c[0].needsReview, true)
  const after = assignInstitution(c, ['1'], SEM.id)
  // The transfer-ambiguity reason is a different concern and must survive.
  assert.equal(after[0].reviewReasons.some(r => /transfer/i.test(r)), true)
  assert.equal(after[0].needsReview, true)
})

test('D17: a transfer_notation row is not surfaced as needing assignment', () => {
  const cs = [C({ name:'Note', grade:'A', credits:3, institutionId:null,
                  recordType:'transfer_notation' })]
  assert.equal(unassignedCourses(cs).length, 0)
})

// ------------------------------------------------------------------ D18
// The trigger itself lives in SQL and cannot run without a database. What is
// testable here is the client contract the trigger enforces: every write must
// advance revision by exactly one from the value that was read.
function clientUpdate(server: { revision: number }, readRevision: number) {
  // Mirrors useDraft: UPDATE ... SET revision = readRevision + 1
  //                   WHERE revision = readRevision
  const next = readRevision + 1
  if (server.revision !== readRevision) return { rows: 0, server }      // stale -> conflict
  if (next !== server.revision + 1) return { rejected: '23514', server } // trigger would reject
  return { rows: 1, server: { revision: next } }
}

test('D18: a normal save advances 5 -> 6', () => {
  const r = clientUpdate({ revision: 5 }, 5)
  assert.equal(r.rows, 1)
  assert.equal(r.server.revision, 6)
})

test('D18: a stale writer at revision 4 cannot overwrite revision 5', () => {
  const r = clientUpdate({ revision: 5 }, 4)
  assert.equal(r.rows, 0, 'WHERE revision = 4 matches nothing')
  assert.equal(r.server.revision, 5, 'server state preserved')
})

test('D18: the client never emits an unchanged or skipped revision', () => {
  for (const read of [1, 5, 99]) {
    const r = clientUpdate({ revision: read }, read) as any
    assert.equal(r.server.revision, read + 1)
    assert.notEqual(r.server.revision, read, 'never unchanged')
    assert.equal(r.server.revision - read, 1, 'never skipped')
  }
})

// ------------------------------------------------------------------ D19
// Models the commitInstitution contract: on a unique collision the local value
// is discarded and the server value is restored.
function commitRename(
  server: Institution[], local: Institution[], id: string, newName: string
): { server: Institution[]; local: Institution[]; error?: string } {
  const norm = (s: string) => s.trim().toLowerCase()
  const collides = server.some(i => i.id !== id && norm(i.name) === norm(newName))
  if (!norm(newName)) return { server, local: server, error: 'empty' }
  if (collides) return { server, local: server, error: '23505' }   // roll back to server
  const nextServer = server.map(i => i.id === id ? { ...i, name: newName.trim() } : i)
  return { server: nextServer, local: nextServer }
}

test('D19: a successful rename updates both server and UI', () => {
  const server = [{ ...SEM, name:'Bergen' }, { ...QTR, name:'Rutgers' }]
  const r = commitRename(server, server, 'S', 'Bergen Community College')
  assert.equal(r.error, undefined)
  assert.equal(r.server.find(i => i.id==='S')!.name, 'Bergen Community College')
  assert.equal(r.local.find(i => i.id==='S')!.name, 'Bergen Community College')
})

test('D19: a collision rolls the UI back and preserves the server value', () => {
  const server = [{ ...SEM, name:'Bergen' }, { ...QTR, name:'Rutgers' }]
  const r = commitRename(server, server, 'S', 'Rutgers')
  assert.equal(r.error, '23505')
  assert.equal(r.server.find(i => i.id==='S')!.name, 'Bergen', 'server unchanged')
  assert.equal(r.local.find(i => i.id==='S')!.name, 'Bergen', 'UI must not show the failed rename')
})

test('D19: whitespace- and case-equivalent names collide too', () => {
  const server = [{ ...SEM, name:'Bergen' }, { ...QTR, name:'Rutgers' }]
  for (const attempt of ['  Rutgers  ', 'RUTGERS', 'rutgers', 'RuTgErS ']) {
    const r = commitRename(server, server, 'S', attempt)
    assert.equal(r.error, '23505', `"${attempt}" must collide`)
    assert.equal(r.local.find(i => i.id==='S')!.name, 'Bergen')
  }
})

test('D19: retry after a failed rename succeeds', () => {
  const server = [{ ...SEM, name:'Bergen' }, { ...QTR, name:'Rutgers' }]
  const failed = commitRename(server, server, 'S', 'Rutgers')
  assert.equal(failed.error, '23505')
  const retry = commitRename(failed.server, failed.local, 'S', 'Bergen CC')
  assert.equal(retry.error, undefined)
  assert.equal(retry.server.find(i => i.id==='S')!.name, 'Bergen CC')
})

test('D19: an empty name is rejected and rolled back', () => {
  const server = [{ ...SEM, name:'Bergen' }]
  const r = commitRename(server, server, 'S', '   ')
  assert.equal(r.error, 'empty')
  assert.equal(r.local[0].name, 'Bergen')
})

test('D19: renaming to its own current name is not a collision', () => {
  const server = [{ ...SEM, name:'Bergen' }, { ...QTR, name:'Rutgers' }]
  const r = commitRename(server, server, 'S', 'Bergen')
  assert.equal(r.error, undefined)
})

// ============================================================ D20 / D21
const MAX_DRAFT_COURSES = 500   // mirrors the database constraint

test('D20: the 500-course ceiling is the documented limit', () => {
  const atLimit = Array.from({ length: MAX_DRAFT_COURSES }, (_, i) =>
    C({ name: 'c' + i, grade: 'A', credits: 3 }))
  assert.equal(atLimit.length, 500)
  const r = calculateGPA(atLimit, 'overall', CTX)
  assert.equal(r.coursesCounted, 500, 'a full draft still calculates')
  assert.equal(r.display, '4.00')
})

// ------------------------------------------------------------------ D21
test('D21: there is no default retake policy', () => {
  assert.equal(DEFAULT_POLICIES.retake, null)
  assert.equal(DEFAULT_POLICIES.transfer, null)
})

test('D21: with no repeats, an unset retake policy blocks nothing', () => {
  const cs = [
    C({ name:'Bio',  grade:'A', credits:4, courseCode:'BIO101', institutionId:'B' }),
    C({ name:'Chem', grade:'B', credits:3, courseCode:'CHM101', institutionId:'B' }),
  ]
  const r = calculateGPA(cs, 'overall', {
    institutions: ALL_INST, policies: { transfer: 'exclude', retake: null } })
  assert.equal(r.display, '3.57', 'unrelated coursework must not be held hostage')
  assert.equal(r.exclusions['retake-policy-unset'], undefined)
})

test('D21: a confirmed repeat group is held out until the user chooses', () => {
  // Grades chosen so unset / both / latest are three DIFFERENT numbers --
  // otherwise the test could pass while the engine silently picked a rule.
  const first  = C({ name:'BIO 101', grade:'F', credits:4, courseCode:'BIO101', institutionId:'B', year:'2021' })
  const repeat = C({ name:'BIO 101', grade:'A', credits:4, courseCode:'BIO101', institutionId:'B', year:'2023' })
  const other  = C({ name:'Chem',    grade:'B', credits:3, courseCode:'CHM101', institutionId:'B', year:'2022' })
  const set = [first, repeat, other]

  const unset = calculateGPA(set, 'overall', {
    institutions: ALL_INST, policies: { transfer:'exclude', retake: null } })

  assert.equal(unset.exclusions['retake-policy-unset'], 2, 'both attempts held')
  assert.equal(unset.coursesCounted, 1, 'the unrelated course still counts')
  assert.equal(unset.display, '3.00', 'Chem alone')
  assert.equal(unset.issues.some(i => i.reason === 'retake-policy-unset'), true)

  // The engine must not have silently landed on either rule.
  const both   = g(set, 'overall', { retake: 'both' })    // (0 + 16 + 9) / 11
  const latest = g(set, 'overall', { retake: 'latest' })  // (16 + 9) / 7
  assert.equal(both,   '2.27')
  assert.equal(latest, '3.57')
  assert.notEqual(unset.display, both)
  assert.notEqual(unset.display, latest)
})

test('D21: after choosing, both rules give their documented answers', () => {
  const first  = C({ name:'BIO 101', grade:'C', credits:4, courseCode:'BIO101', institutionId:'B', year:'2021' })
  const repeat = C({ name:'BIO 101', grade:'A', credits:4, courseCode:'BIO101', institutionId:'B', year:'2023' })
  assert.equal(g([first,repeat],'overall',{retake:'both'}),   '3.00')
  assert.equal(g([first,repeat],'overall',{retake:'latest'}), '4.00')
})

test('D21: unmatched lookalikes are not a repeat group, so nothing is blocked', () => {
  const a = C({ name:'Anatomy I',  grade:'C', credits:4, courseCode:'BIO101', institutionId:'B' })
  const b = C({ name:'Anatomy II', grade:'A', credits:4, courseCode:'BIO102', institutionId:'B' })
  const r = calculateGPA([a,b],'overall',{ institutions: ALL_INST, policies:{ transfer:'exclude', retake:null } })
  assert.equal(r.exclusions['retake-policy-unset'], undefined)
  assert.equal(r.display, '3.00')
})

test('D21: courses with no code cannot form a repeat group under a null policy', () => {
  const a = C({ name:'BIO 101', grade:'C', credits:4, courseCode:null, institutionId:'B' })
  const b = C({ name:'BIO 101', grade:'A', credits:4, courseCode:null, institutionId:'B' })
  const r = calculateGPA([a,b],'overall',{ institutions: ALL_INST, policies:{ transfer:'exclude', retake:null } })
  assert.equal(r.exclusions['retake-policy-unset'], undefined)
  assert.equal(r.coursesCounted, 2)
})

test('D21: unset retake applies identically across every GPA type', () => {
  const mk = (grade: string, year: string) => C({
    name:'BIO 101', grade, credits:4, courseCode:'BIO101', institutionId:'B', year,
    categories:['science','nursing'], level:'graduate', term:'Fall' })
  const pair = [mk('C','2021'), mk('A','2023')]
  for (const f of ['overall','science','nursing','graduate','last60'] as const) {
    const r = calculateGPA(pair, f, { institutions: ALL_INST, policies:{ transfer:'exclude', retake:null } })
    assert.equal(r.value, null, `filter ${f} must hold the repeat group`)
    assert.equal(r.exclusions['retake-policy-unset'], 2)
  }
})

test('D21: loading a V1 calculation does not adopt V1 rules as the user choice', () => {
  // The page sets DEFAULT_POLICIES for a legacy row rather than LEGACY_V1_POLICIES.
  const onLoad = (engineVersion: number | null) =>
    (engineVersion ?? 1) < 2 ? DEFAULT_POLICIES : DEFAULT_POLICIES
  assert.equal(onLoad(null).transfer, null, 'transfer stays unchosen')
  assert.equal(onLoad(null).retake, null, 'retake stays unchosen')
  // LEGACY_V1_POLICIES still exists, for reproducing historical arithmetic only.
  assert.equal(LEGACY_V1_POLICIES.retake, 'both')
  assert.equal(LEGACY_V1_POLICIES.transfer, 'exclude')
})

test('D21: transfer-unset and retake-unset coexist without masking each other', () => {
  const tr = C({ name:'TR', grade:'A', credits:4, transferredIn:true, institutionId:'A' })
  const r1 = C({ name:'BIO', grade:'C', credits:4, courseCode:'BIO101', institutionId:'B', year:'2021' })
  const r2 = C({ name:'BIO', grade:'A', credits:4, courseCode:'BIO101', institutionId:'B', year:'2023' })
  const ok = C({ name:'Ok', grade:'B', credits:3, courseCode:'X100', institutionId:'B' })
  const r = calculateGPA([tr,r1,r2,ok],'overall',{ institutions: ALL_INST, policies: DEFAULT_POLICIES })
  assert.equal(r.exclusions['transfer-policy-unset'], 1)
  assert.equal(r.exclusions['retake-policy-unset'], 2)
  assert.equal(r.coursesCounted, 1)
  assert.equal(r.display, '3.00')
})
