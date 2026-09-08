'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import jsPDF from 'jspdf'
import {
  validateDetectedScale, planScaleMerge, fromStoredScale, toStoredScale,
  normalizeGradeSymbol, type DetectedGradingScale, type ScaleMerge,
} from '@/lib/gpa/gradingScale'
import {
  ChevronDown, ClipboardList, FileDown, FileText, GraduationCap, Layers, Loader2,
  Plus, Save, Scale, School, Upload,
} from 'lucide-react'
import {
  BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD, Notice, SaveStatus,
  TabPanel, Tabs, type TabSpec,
} from './components/workspace'
import { GpaHero } from './components/GpaHero'
import { CoursesPanel } from './components/CoursesPanel'
import { SchoolsPanel, scaleSummary } from './components/SchoolsPanel'
import { PoliciesPanel, SavedPanel } from './components/SettingsPanels'
import { SetupCard } from './components/SetupCard'
import { DestinationModal, type UploadDestination } from './components/DestinationModal'
import { ImportProgress, ImportSuccessFlash } from './components/ImportProgress'
import { TranscriptLimitModal } from './components/TranscriptLimitModal'
import {
  IDLE_IMPORT, advance, beginImport, blockedUploadReason, canStartImport, classifyFailure,
  fail, noteAttempt, succeed, type FailureKind, type ImportDestination, type ImportState,
} from '@/lib/gpa/importProgress'
import { importMetrics, recordImport } from '@/lib/gpa/importTelemetry'
import { CombineModal, NewAnalysisModal, type NewAnalysisKind } from './components/CombineModal'
import {
  planCombine, planCombineWithNewCourses, type CombineSource,
} from '@/lib/gpa/combine'
import { deriveSetupState } from '@/lib/gpa/setup'
import {
  dropIfForeign, noticeFor, scopedTo, type ScopedNotice,
} from '@/lib/gpa/notices'
import {
  linkedTransferCount, setTransferLink, transferReviews,
} from '@/lib/gpa/transferLinks'
import { institutionHintFromFilename } from '@/lib/gpa/filenameHint'
import {
  institutionsUsedIn, institutionsUnusedIn, legendNoteFor, retakeDisclaimer,
  GPA_DISCLAIMER_D43,
} from '@/lib/gpa/presentation'
import { courseAnchorsFromText, matchAnchors } from '@/lib/pdf/anchors'
import { applyTransferSections } from '@/lib/pdf/transferSections'
import {
  parseTranscriptTotals, reconcile, scoreAttempt, pickBestAttempt, gradesMissingFromScale,
  type ReconcileResult,
} from '@/lib/gpa/reconcile'
import { applyCategoryClassification } from '@/lib/gpa/classification'
import {
  planInstitutionImport,
  gradingScaleStatus,
  STANDARD_SCALE,
  resolveInstitutionName,
  normalizeName,
  assignInstitution,
  unassignedCourses,
  DEFAULT_POLICIES,
  LEGACY_V1_POLICIES,
  calculateGPA,
  collectIssues,
  normalizeCredits,
  upgradeCourses,
  ENGINE_VERSION,
  SELECTABLE_GRADES,
  type Course,
  type Institution,
  type GradingScale,
  type CreditSystem,
  type AcademicLevel,
} from '@/lib/gpa'
import { useGpaAnalyses } from '@/lib/gpa/useAnalyses'
import {
  analysisNameFromInstitutions, resolveAnalysisName, canCreateAnalysis, smartAnalysisName,
  MAX_ANALYSES_PER_USER,
  type GpaAnalysis,
} from '@/lib/gpa/analyses'

/** Mirrors the gpa_drafts_courses_is_array database constraint (D20). */
const MAX_DRAFT_COURSES = 500

/**
 * A transcript-detected scale that disagrees with one already established from
 * a previous transcript. Nothing is written until the user picks (D38 item 5).
 */
interface ScaleConflict {
  institutionId: string
  institutionName: string
  merge: ScaleMerge
}

/** Exact-name lookup, used only to attach a detected scale to a live row. */
function byNameForScales(list: readonly Institution[], name: unknown): string | null {
  const key = normalizeName(String(name ?? ''))
  if (!key) return null
  const hits = list.filter(i => normalizeName(i.name) === key)
  return hits.length === 1 ? hits[0].id : null
}

export default function GPACalculator() {
  const [mode, setMode] = useState<'manual' | 'ai'>('manual')
  // `courses` and `policies` now live in the database-backed draft (D3).
  /**
   * Transcript import progress. `analyzing` is derived from it rather than
   * tracked separately, so the controls and the panel can never disagree about
   * whether an analysis is running.
   */
  const [importState, setImportState] = useState<ImportState>(IDLE_IMPORT)
  const analyzing = importState.phase === 'running'
  /**
   * Brief "Transcript analyzed" confirmation; carries the course count.
   *
   * D54: every transient notice below records the analysis it is about, so one
   * analysis's import can never narrate another's.
   */
  const [importFlash, setImportFlash] = useState<ScopedNotice<number> | null>(null)
  /**
   * What the import actually did, reported in the page instead of in an
   * alert(). Success should reveal the workspace, not interrupt it with a
   * dialog the user has to dismiss before they can look at their GPA.
   */
  const [importNote, setImportNote] =
    useState<ScopedNotice<{ title: string; lines: string[] }> | null>(null)
  /**
   * The file and destination of the import in hand, so Retry can send the same
   * transcript without asking the user to find it again. Session state in a
   * ref: it is never persisted, and it is dropped as soon as an import
   * succeeds or a new file is chosen.
   */
  const pendingImport = useRef<{ file: File; destination: ImportDestination } | null>(null)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [savedCalculations, setSavedCalculations] = useState<any[]>([])
  const [calculationName, setCalculationName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  /** D59: the manually added course still being filled in, if any. */
  const [newCourseId, setNewCourseId] = useState<string | null>(null)
  const [viewingCalc, setViewingCalc] = useState<any>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [assignTargetId, setAssignTargetId] = useState<string>('')
  const router = useRouter()
  const supabase = createClient()

  const {
    loaded: draftLoaded, analyses, current, currentId, selectAnalysis,
    createAnalysis, renameAnalysis, deleteAnalysis, reloadAnalyses,
    courses, setCourses, policies, setPolicies,
    institutions, setInstitutions, saveState, retry: retrySave,
    conflicts, resolve,
  } = useGpaAnalyses(userId)
  const [conflictChoices, setConflictChoices] = useState<Record<string,'mine'|'theirs'>>({})

  const isUltimate = userTier === 'ultimate'
  const [saving, setSaving] = useState(false)

  // D60: has this account already used its one transcript analysis?
  //
  // Read from the ledger, which the user can SEE but cannot write. It is
  // ADVISORY ONLY -- it decides how the button is worded and whether the
  // upgrade prompt opens before a file is chosen. Every real decision is taken
  // by the server, under a lock, at /api/parse-pdf and /api/analyze-transcript.
  // null means "not known yet": the attempt goes through and the server
  // answers, rather than a failed read locking someone out of their first one.
  const [transcriptUsed, setTranscriptUsed] = useState<boolean | null>(null)
  const [limitModal, setLimitModal] = useState(false)
  useEffect(() => {
    if (!userId) { setTranscriptUsed(null); return }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('gpa_transcript_sources').select('id').eq('user_id', userId).limit(1)
      if (!cancelled) setTranscriptUsed(error ? null : (data?.length ?? 0) > 0)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])
  /** Ultimate is unlimited; everyone else may start their first transcript. */
  const canUploadTranscript = isUltimate || transcriptUsed !== true

  // One pass per course list instead of recomputing on every card render.
  const [scaleConflicts, setScaleConflicts] = useState<ScaleConflict[]>([])
  // Each note says whether it needs the user's attention. A scale that was
  // simply detected and applied is reported by the setup card's status chip,
  // not by a standalone panel repeating what already worked.
  const [scaleNotes, setScaleNotes] =
    useState<ScopedNotice<{ actionable: boolean; text: string }[]> | null>(null)
  const actionableScaleNotes = useMemo(
    () => (noticeFor(scaleNotes, currentId) ?? []).filter(n => n.actionable).map(n => n.text),
    [scaleNotes, currentId])
  const [scaleEditorId, setScaleEditorId] = useState<string | null>(null)
  // D44: set only when automatic reconciliation AND its retry both failed.
  const [importReview, setImportReview] = useState<ScopedNotice<ReconcileResult> | null>(null)
  /**
   * Held open while the upload waits for the user to say where the transcript
   * should go. The resolver is stored so the async import can simply await it.
   */
  const [destinationAsk, setDestinationAsk] =
    useState<{ resolve: (c: UploadDestination) => void } | null>(null)

  const askDestination = () => new Promise<UploadDestination>(resolve => {
    setDestinationAsk({ resolve })
  })

  // D47: combining analyses that already hold structured coursework. Nothing
  // in these paths reaches a PDF or the transcript analyzer, and nothing in
  // them writes to an existing analysis: every combination creates a new one.
  const [newAnalysisAsk, setNewAnalysisAsk] = useState(false)
  const [combineMode, setCombineMode] = useState<'new' | 'with' | null>(null)
  const [combining, setCombining] = useState(false)
  const [combineError, setCombineError] =
    useState<{ title?: string; message: string } | null>(null)
  const [combineNotice, setCombineNotice] = useState<ScopedNotice<string> | null>(null)

  const sourceOf = (a: GpaAnalysis): CombineSource =>
    ({ id: a.id, name: a.name, courses: a.courses, policies: a.policies })

  /**
   * Builds a NEW analysis from coursework the user already owns.
   *
   * In 'with' mode the analysis that is open is simply one more source: it is
   * copied like every other, so it comes out of this unchanged.
   */
  const createCombined = async (ids: string[]) => {
    if (combining) return
    setCombining(true)
    try {
      const picked = ids
        .map(id => analyses.find(a => a.id === id))
        .filter(Boolean)
        .map(a => sourceOf(a as GpaAnalysis))
      const openOne = combineMode === 'with' && current ? [sourceOf(current)] : []
      const sources = [...openOne, ...picked]
      const plan = planCombine({
        sources, existingAnalyses: analyses,
        // D50: institutions are account-level, so an originating school named
        // on a transfer notation resolves against the same rows the coursework
        // already points at.
        institutions,
        canCreate: canCreateAnalysis(analyses),
        nameFor: id => analyses.find(a => a.id === id)?.name ?? null,
      })
      if (!plan.ok) {
        setCombineError({ title: plan.title,
          message: plan.message ?? 'Those analyses could not be combined.' })
        return
      }
      // One insert, so a failure cannot leave a half-populated analysis, and
      // no source is written to at any point.
      const created = await createAnalysis(plan.name, {
        courses: plan.courses!, policies: plan.policies!,
      })
      if (created) {
        setCombineNotice(scopedTo(created.id,
          `Created “${created.name}” with ${plan.courses!.length} course(s). ` +
          `Your original analyses are unchanged.`))
        setCombineMode(null)
      }
    } finally {
      setCombining(false)
    }
  }
  const [activeTab, setActiveTab] = useState('courses')

  const engineCtx = useMemo(() => ({ institutions, policies }), [institutions, policies])
  const results = useMemo(() => ({
    overall: calculateGPA(courses, 'overall', engineCtx),
    science: calculateGPA(courses, 'science', engineCtx),
    nursing: calculateGPA(courses, 'nursing', engineCtx),
    last60: calculateGPA(courses, 'last60', engineCtx),
    graduate: calculateGPA(courses, 'graduate', engineCtx),
  }), [courses, engineCtx])
  const issues = useMemo(() => collectIssues(courses, engineCtx), [courses, engineCtx])
  const hasGraduate = courses.some(c => c.level === 'graduate')
  const ex = results.overall.exclusions
  const quarterExcluded = ex['unsupported-credit-system'] ?? 0
  const unknownSystem = ex['credit-system-unknown'] ?? 0
  const noInstitution = ex['no-institution'] ?? 0
  const transferUnset = ex['transfer-policy-unset'] ?? 0
  const retakeUnresolved = ex['retake-policy-unset'] ?? 0
  // D40: a real grade the institution's scale simply does not define. Never a
  // 0.00 and never silently scored on the standard table.
  const gradeNotInScale = ex['grade-not-in-scale'] ?? 0
  const notInScaleIssues = useMemo(
    () => issues.filter(i => i.reason === 'grade-not-in-scale'), [issues])
  // A policy still awaiting a decision that is actually holding coursework out.
  const policyAttention =
    (policies.transfer === null && transferUnset > 0 ? 1 : 0) +
    (policies.retake === null && retakeUnresolved > 0 ? 1 : 0)
  // Institutions stay shared across analyses; only the display is scoped, so a
  // school the current analysis does not use cannot look like it takes part.
  const usedInstitutions = useMemo(
    () => institutionsUsedIn(courses, institutions), [courses, institutions])
  const unusedInstitutions = useMemo(
    () => institutionsUnusedIn(courses, institutions), [courses, institutions])

  const notInScaleIds = useMemo(
    () => new Set(notInScaleIssues.map(i => i.courseId)), [notInScaleIssues])
  const blockedPending = unknownSystem + noInstitution + transferUnset + retakeUnresolved + gradeNotInScale
  const show = (v: string | null) => v ?? '\u2014'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
        if (profile) {
          setUserTier(profile.subscription_tier || 'free')
        }

        const { data: calcs } = await supabase
          .from('gpa_calculations')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
        if (calcs) setSavedCalculations(calcs)
      }
    }
    init()
  }, [])

  const handleRename = async () => {
    if (!current) return
    const next = prompt('Rename this analysis', current.name)
    if (next === null) return
    await renameAnalysis(current.id, next)
  }

  const addCourse = () => {
    // D20: the 500-course ceiling is enforced in the database. Say so here
    // rather than letting the autosave fail with a constraint error.
    if (courses.length >= MAX_DRAFT_COURSES) {
      alert(`A draft can hold up to ${MAX_DRAFT_COURSES} courses. Save this calculation and start a new one to continue.`)
      return
    }
    // D59: a blank row and a hidden three-dot menu made the user hunt for the
    // place to type. The new course opens straight into its own editor, and is
    // remembered as new so cancelling discards it rather than leaving an empty
    // row behind.
    const id = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setCourses([...courses, {
      id,
      institutionId: institutions[0]?.id ?? null,
      courseCode: null,
      name: '',
      grade: 'A',
      credits: 3,
      year: '',
      term: '',
      categories: ['general'],
      categorySource: 'default',
      level: 'undergraduate',
      levelSource: 'default',
      recordType: 'coursework',
      transferredIn: false,
      needsReview: false,
      reviewReasons: [],
    }])
    setNewCourseId(id)
    setEditingId(id)
    setActiveTab('courses')
  }

  /** Puts a course back exactly as it was, for Cancel. */
  const replaceCourse = (id: string, course: Course) =>
    setCourses(prev => prev.map(c => (c.id === id ? course : c)))

  // --- Institutions ---------------------------------------------------------
  // Persisted immediately (they are small and referenced by course rows), and
  // written through the browser client so RLS scopes them to this user.
  const addInstitution = async () => {
    if (!userId) { alert('Please log in to add schools.'); return }
    const name = prompt('School name (e.g. Rutgers University)')?.trim()
    if (!name) return
    const { data, error } = await supabase
      .from('gpa_institutions')
      .insert({ user_id: userId, name, credit_system: 'unknown' })
      .select('id, name, credit_system').maybeSingle()
    if (error) {
      alert(error.code === '23505' ? 'That school is already in your list.' : 'Could not add that school.')
      return
    }
    if (data) {
      setInstitutions([...institutions,
        // D39: a brand new school has NO established scale. Not 'default'.
        { id: data.id, name: data.name, creditSystem: data.credit_system, gradingScale: null }])
    }
  }

  /** Local-only edit. Committed to the database on blur (see commitInstitution). */
  const editInstitution = (id: string, patch: Partial<Institution>) => {
    setInstitutions(institutions.map(i => i.id === id ? { ...i, ...patch } : i))
  }

  /**
   * D19: the database is the source of truth for institution names. A unique
   * collision (23505) must not leave the UI showing a rename that did not
   * happen, so the local value is rolled back to the server's.
   */
  const commitInstitution = async (id: string, patch: Partial<Institution>) => {
    if (!userId) return
    const row: Record<string, unknown> = {}
    if (patch.name !== undefined) row.name = String(patch.name).trim()
    if (patch.creditSystem !== undefined) row.credit_system = patch.creditSystem
    // Scales live on gpa_institutions, never on a draft, so saving one cannot
    // bump any analysis revision (D41 item 16).
    if (patch.gradingScale !== undefined) row.grading_scale = toStoredScale(patch.gradingScale)
    if (Object.keys(row).length === 0) return
    if (row.name !== undefined && !String(row.name)) {
      alert('A school needs a name.')
      await reloadInstitutions()
      return
    }

    const { error } = await supabase
      .from('gpa_institutions').update(row).eq('id', id).eq('user_id', userId)

    if (error) {
      alert(error.code === '23505'
        ? 'You already have an institution with this name.'
        : 'That change could not be saved.')
      await reloadInstitutions()   // discard the optimistic local value
      return
    }
    if (patch.name !== undefined) editInstitution(id, { name: String(row.name) })
  }

  /**
   * D38 item 5: a transcript that disagrees with an already-detected scale
   * never wins on its own. Nothing was written when the conflict was raised;
   * this is where the user's choice is applied.
   */
  const resolveScaleConflict = async (institutionId: string, take: 'existing' | 'detected') => {
    const c = scaleConflicts.find(x => x.institutionId === institutionId)
    if (!c) return
    if (take === 'detected' && c.merge.next) {
      await commitInstitution(institutionId, { gradingScale: c.merge.next })
      editInstitution(institutionId, { gradingScale: c.merge.next })
    }
    setScaleConflicts(scaleConflicts.filter(x => x.institutionId !== institutionId))
  }

  /** Re-reads institutions from the database, discarding unsaved local edits. */
  const reloadInstitutions = async () => {
    if (!userId) return
    const { data } = await supabase
      .from('gpa_institutions').select('id, name, credit_system, grading_scale')
      .eq('user_id', userId).order('name')
    if (data) {
      setInstitutions(data.map((r: any) =>
        ({ id: r.id, name: r.name, creditSystem: r.credit_system,
           gradingScale: fromStoredScale(r.grading_scale) })))
    }
  }

  // --- D17: guided bulk assignment ------------------------------------------
  const unassigned = useMemo(() => unassignedCourses(courses), [courses])

  // One normalized view of everything unresolved, so the interface can present
  // it once instead of as four panels describing the same unset field.
  /** D50: transfer relationships to confirm, required ones already marked. */
  const pendingTransfers = useMemo(
    () => transferReviews(courses, institutions), [courses, institutions])

  const setupState = useMemo(() => deriveSetupState({
    courses, institutions, policies,
    unassignedCount: unassigned.length,
    transferUnset, retakeUnresolved, quarterExcluded, issues,
    unresolvedTransfers: pendingTransfers,
  }), [courses, institutions, policies, unassigned.length, transferUnset,
       retakeUnresolved, quarterExcluded, issues, pendingTransfers])

  /**
   * D50: the user's answer for one transfer record, which outranks automation.
   * Recorded on the notation and never written back to a source analysis.
   */
  const chooseTransferLink = (notationId: string, courseId: string | null) =>
    setCourses(prev => setTransferLink(prev, notationId, courseId))

  // "Pending setup" only when setup is genuinely why there is no number. A
  // partially-configured analysis that still produces an Overall shows it.
  const heroPending = setupState.blocked && results.overall.value === null

  /** Same write Schools & Grading performs - no second copy of this state. */
  const setInstitutionCreditSystem = (id: string, v: CreditSystem) => {
    editInstitution(id, { creditSystem: v })
    commitInstitution(id, { creditSystem: v })
  }


  const toggleSelected = (id: string) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const assignSelectedTo = (institutionId: string) => {
    if (selectedIds.length === 0) { alert('Select at least one course first.'); return }
    if (!institutionId) { alert('Choose a school to assign them to.'); return }
    setCourses(assignInstitution(courses, selectedIds, institutionId))
    setSelectedIds([])
  }

  /**
   * D16: deleting an institution NEVER deletes coursework. Courses are detached
   * and flagged for review; their grades and credits are untouched.
   */
  const removeInstitution = async (id: string) => {
    const attached = courses.filter(c => c.institutionId === id)
    const ok = confirm(
      attached.length > 0
        ? `Deleting this school will NOT delete its coursework.\n\n` +
          `${attached.length} course(s) will become unassigned and will require review — ` +
          `they cannot count toward your GPA until you assign them to a school with a ` +
          `credit system set.\n\nDelete the school?`
        : 'Delete this school?'
    )
    if (!ok) return

    setCourses(courses.map(c => c.institutionId === id
      ? {
          ...c,
          institutionId: null,
          needsReview: true,
          reviewReasons: [
            ...(c.reviewReasons ?? []).filter(r => !r.startsWith('Unassigned:')),
            'Unassigned: the school this course belonged to was deleted. Assign a school to include it in your GPA.',
          ],
        }
      : c))
    setInstitutions(institutions.filter(i => i.id !== id))
    if (userId) await supabase.from('gpa_institutions').delete().eq('id', id).eq('user_id', userId)
  }

  const removeCourse = (id: string) => {
    setCourses(courses.filter(c => c.id !== id))
  }

  // D4: when the user edits a classified field, record that the value is now
  // user-authoritative so a later AI import cannot overwrite it.
  const updateCourse = (
    id: string, field: keyof Course, value: any, sourceField?: keyof Course
  ) => {
    setCourses(courses.map(c => c.id === id
      ? { ...c, [field]: value, ...(sourceField ? { [sourceField]: 'user' } : {}) }
      : c))
  }

  const toggleCategory = (id: string, category: 'science' | 'nursing' | 'general') => {
    setCourses(courses.map(c => {
      if (c.id === id) {
        const hasCategory = c.categories.includes(category)
        let newCategories: ('science' | 'nursing' | 'general')[]
        
        if (hasCategory) {
          newCategories = c.categories.filter(cat => cat !== category)
          if (newCategories.length === 0) newCategories = ['general']
        } else {
          newCategories = [...c.categories.filter(cat => cat !== 'general'), category]
        }
        
        // D4: once the user classifies, that choice is authoritative.
        return { ...c, categories: newCategories, categorySource: 'user' as const }
      }
      return c
    }))
  }

  /** Carries a classified failure out of the pipeline without an alert(). */
  class ImportError extends Error {
    kind: FailureKind
    constructor(kind: FailureKind, message?: string) {
      super(message || kind)
      this.kind = kind
    }
  }

  const handleTranscriptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Cleared straight away so choosing the SAME file again still fires change.
    e.target.value = ''

    // One analysis at a time. A second transcript would start a second AI call
    // and land in a workspace whose coursework is about to change underneath it.
    if (!canStartImport(importState)) return
    // D60: Free and Premium get their first transcript. Once the allowance is
    // spent the answer is an upgrade, not a lecture -- and never "delete the
    // one you have", which would not give it back.
    if (!canUploadTranscript) { setLimitModal(true); return }
    if (!file || file.type !== 'application/pdf') {
      alert('Please upload a PDF file')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      alert('That file is larger than 15 MB. Please upload a smaller PDF.')
      return
    }

    // D33/D47: the destination is settled BEFORE any analysis begins, so the
    // progress panel can say what will happen and a retry can repeat it without
    // asking again. Cancelling here has touched nothing: no request has been
    // made, no analysis created, no coursework changed.
    let destination: ImportDestination = 'fill'
    if (courses.length > 0) {
      const choice = await askDestination()
      if (choice === 'cancel') { pendingImport.current = null; return }
      destination = choice
    }

    pendingImport.current = { file, destination }
    setImportFlash(null)
    await runImport(file, destination)
  }

  /**
   * Sends the same transcript again after a failure.
   *
   * Safe to repeat because a failed import created nothing: the only writes
   * before the end of the pipeline are institution rows, which are keyed by
   * name and adopted rather than duplicated, and the analysis itself is created
   * only once the coursework is in hand.
   */
  const retryImport = () => {
    const pending = pendingImport.current
    if (!pending || !canStartImport(importState)) return
    runImport(pending.file, pending.destination)
  }

  const runImport = async (file: File, destination: ImportDestination) => {
    // Progress is tracked locally as well as in state, because setState is not
    // readable synchronously and every stage change here is a real event.
    let st = beginImport({
      destination, analysisName: current?.name ?? null, fileName: file.name, now: Date.now(),
    })
    const push = (next: ImportState) => { st = next; setImportState(next) }
    push(st)

    // D60 pre-flight, before a single request is made: 'separate' and
    // 'combine' both need a NEW analysis, and D35 caps how many an account may
    // hold. Discovering that AFTER the analysis would cost a Free or Premium
    // user their one lifetime transcript for nothing. 'fill' pours into an
    // analysis that already exists and is never affected.
    if (destination !== 'fill' && !canCreateAnalysis(analyses)) {
      pendingImport.current = null
      push(fail(st, 'analysis-limit', Date.now()))
      return
    }

    let numPages: number | undefined
    let promptTokens = 0
    let completionTokens = 0

    try {
      push(advance(st, 'reading'))
      const formData = new FormData()
      formData.append('file', file)
      
      const parseResponse = await fetch('/api/parse-pdf', {
        method: 'POST',
        body: formData
      })
      
      const payload = await parseResponse.json().catch(() => ({} as any))
      const { text, error, legendTables, imageOnly, code } = payload
      numPages = typeof payload?.numPages === 'number' ? payload.numPages : undefined

      if (!parseResponse.ok || error || !text) {
        // A scanned PDF is a different problem from a slow service, and the
        // user is told which one it was rather than being sent to hunt for a
        // better file after an upstream timeout.
        throw new ImportError(
          classifyFailure({ status: parseResponse.status, imageOnly, message: error, code }), error)
      }

      push(advance(st, 'analyzing'))

      // D44: the transcript's own printed totals, captured as an integrity
      // signal. They are never a course and never become the user's GPA.
      const printedTotals = parseTranscriptTotals(text)
      // D47: a deterministic inventory of the course rows the document prints.
      // Independent of the model, so it catches an omission that two agreeing
      // AI runs never would -- and it works on transcripts that print no totals.
      const anchors = courseAnchorsFromText(text)
      const rowsOf = (p: any) =>
        (Array.isArray(p) ? p : (Array.isArray(p?.courses) ? p.courses : [])) as any[]
      const anchorGap = (p: any) => {
        if (anchors.length === 0) return null
        return matchAnchors(anchors, rowsOf(p).map(r => ({
          courseCode: r?.courseCode, name: r?.name, credits: r?.credits,
        })))
      }

      /** One analysis attempt. `focus` steers a retry at what went missing. */
      // D46: some transcripts print the school only in a letterhead image, so
      // the text layer never carries it. The filename is a weak fallback.
      const nameHint = institutionHintFromFilename(file.name) ?? undefined
      // D60: issued by the server when the analysis actually succeeds, and the
      // same for both passes of one import. Never generated here.
      let transcriptSourceId: string | null = null
      const analyzeOnce = async (focus?: string, reason?: 'structural' | 'scale') => {
        // Every attempt is counted, so a slow import can later be told apart
        // from one that quietly needed two passes.
        push(noteAttempt(st, reason))
        const res = await fetch('/api/analyze-transcript', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text, focus, nameHint, legendTables,
            // So the server can apply the same D35 pre-flight to a caller that
            // did not come through this page.
            willCreateAnalysis: destination !== 'fill',
          }),
        })
        const body = await res.json().catch(() => ({} as any))
        if (!res.ok) {
          throw new ImportError(
            classifyFailure({ status: res.status, message: body?.error, code: body?.code }),
            body?.error || 'Transcript analysis failed.')
        }
        if (typeof body?.transcriptSourceId === 'string' && body.transcriptSourceId) {
          transcriptSourceId = body.transcriptSourceId
        }
        // Counts only, for cost analysis later. Never any transcript content.
        promptTokens += Number(body?.usage?.promptTokens) || 0
        completionTokens += Number(body?.usage?.completionTokens) || 0
        const content: string = body.content || ''
        // The schema is an OBJECT ({institutions, courses}). The previous
        // array-only regex matched from the first "[" to the last "]", which
        // spans both arrays and is not valid JSON. Prefer an object, and still
        // accept a bare array so an older-style response keeps working.
        const m = content.match(/\{[\s\S]*\}/) ?? content.match(/\[[\s\S]*\]/)
        if (!m) return null
        try { return JSON.parse(m[0]) } catch { return null }
      }

      /**
       * Reconciliation runs on the transcript-native reading, so it is done on
       * a throwaway shape before institutions or policies exist. The standard
       * scale applies here, which is what an unconfirmed institution uses.
       */
      const scoreable = (p: any): Course[] => {
        const rows = Array.isArray(p) ? p : (Array.isArray(p?.courses) ? p.courses : [])
        return rows.map((c: any, i: number) => ({
          id: 'probe-' + i, institutionId: 'probe', courseCode: c?.courseCode ?? null,
          name: String(c?.name ?? ''), grade: String(c?.grade ?? ''),
          credits: normalizeCredits(c?.credits) ?? 0,
          year: c?.year, term: c?.term, categories: ['general'], categorySource: 'ai',
          level: 'unknown', levelSource: 'ai',
          recordType: c?.recordType === 'transfer_notation' ? 'transfer_notation' : 'coursework',
          transferredIn: false, needsReview: false, reviewReasons: [],
        })) as Course[]
      }

      let parsed = await analyzeOnce()
      let recon = parsed
        ? reconcile(scoreable(parsed), 'probe', undefined, printedTotals)
        : { status: 'no-signal' as const, checks: [] }

      /** Grades used by the coursework that the detected scale does not define. */
      const scaleGaps = (p: any): string[] => {
        const inst = (p?.institutions ?? []).find((i: any) => i?.gradingScale?.points)
        if (!inst) return []
        return gradesMissingFromScale(scoreable(p), inst.name, inst.gradingScale.points)
      }

      // Automatic repair: one purposeful retry that names what is missing, so
      // the second pass is not the same blind request as the first. A scale
      // that cannot score the grades in hand is as incomplete as missing rows.
      const gapsFirst = parsed ? scaleGaps(parsed) : []
      const matchFirst = parsed ? anchorGap(parsed) : null
      const structuralMiss = matchFirst ? matchFirst.unmatched.length : 0
      if (parsed && (recon.status === 'mismatch' || gapsFirst.length > 0 || structuralMiss > 0)) {
        const focus = structuralMiss > 0
          ? `A previous pass of this transcript missed ${structuralMiss} course row(s) that the `
            + `document prints. Re-read it and return EVERY course row, including these: `
            + matchFirst!.unmatched.slice(0, 12)
                .map(a => `"${a.code} ${a.title} (${a.credits} credits)"`).join(', ')
            + `. Rows printed with no grade keep an empty grade — do not invent one, and do not `
            + `invent any course that is not printed in the document.`
          : gapsFirst.length > 0 && recon.status !== 'mismatch'
          ? `A previous pass read this transcript's grading legend only partway: the scale it `
            + `returned has no entry for ${gapsFirst.join(', ')}, yet coursework on this transcript `
            + `carries those grades. Re-read the grading legend and return EVERY row of the table `
            + `that applies, quoting each row verbatim in "evidence". Do not invent a value for any `
            + `grade the legend does not print.`
          : recon.missingCredits !== undefined
          ? `A previous pass of this transcript found only part of the coursework: ` +
            `about ${recon.missingCredits} graded credits are missing against the totals the ` +
            `transcript prints. Re-read it and return EVERY graded row, paying particular ` +
            `attention to coursework immediately after a column or page continuation marker. ` +
            `Do not invent any course that is not printed in the document.`
          : `A previous pass of this transcript did not add up to the totals it prints. ` +
            `Re-read it carefully and return every graded row exactly as printed. ` +
            `Do not invent any course.`
        const second = await analyzeOnce(focus, structuralMiss > 0 ? 'structural' : 'scale')
        if (second) {
          const totalsArr = printedTotals
          const a = { value: parsed, score: scoreAttempt(scoreable(parsed), 'probe', undefined, totalsArr) }
          const b = { value: second, score: scoreAttempt(scoreable(second), 'probe', undefined, totalsArr) }
          // Document-grounded evidence decides, in order: rows the document
          // prints, then the legend, then the numeric totals. Agreement between
          // two model runs is never on its own a reason to accept either.
          const missA = anchorGap(parsed)?.unmatched.length ?? 0
          const missB = anchorGap(second)?.unmatched.length ?? 0
          const gapsA = scaleGaps(parsed), gapsB = scaleGaps(second)
          const best = missA !== missB
            ? (missB < missA ? b : a)
            : gapsA.length !== gapsB.length
              ? (gapsB.length < gapsA.length ? b : a)
              : pickBestAttempt([a, b])
          if (best) parsed = best.value
          recon = reconcile(scoreable(parsed), 'probe', undefined, printedTotals)
        }
      }

      push(advance(st, 'validating'))

      // Last resort only: the import still proceeds, but it is not presented as
      // complete. Nothing is fabricated to make the totals agree.
      const finalMiss = parsed ? (anchorGap(parsed)?.unmatched.length ?? 0) : 0
      // Held, not shown yet: which analysis this review is about is not decided
      // until the destination branch below creates or fills one.
      const pendingReview: ReconcileResult | null = (
        recon.status === 'mismatch' ? recon
        : finalMiss > 0
          ? {
              status: 'mismatch' as const,
              checks: [{ name: 'course rows found in the document', printed: anchors.length,
                computed: anchors.length - finalMiss, delta: -finalMiss, ok: false }],
              message: `The document appears to print ${anchors.length} course rows, but ` +
                `${finalMiss} of them could not be read.`,
            }
          : null)

      if (parsed) {
        const rawCourses = Array.isArray(parsed) ? parsed : parsed?.courses
        const detected = Array.isArray(parsed?.institutions) ? parsed.institutions : []
        if (!Array.isArray(rawCourses)) {
          throw new ImportError('unreadable', 'The analysis came back in a shape we could not read.')
        }

        // ---- D27: resolve institution NAMES the model returned into real rows.
        // The model never supplies IDs; the application owns that mapping.
        const plan = planInstitutionImport(detected, institutions)
        let liveInstitutions = [...institutions]

        for (const spec of plan.toCreate) {
          const { data, error } = await supabase
            .from('gpa_institutions')
            .insert({ user_id: userId, name: spec.name, credit_system: spec.creditSystem })
            .select('id, name, credit_system, grading_scale').maybeSingle()
          if (data) {
            liveInstitutions.push({ id: data.id, name: data.name, creditSystem: data.credit_system,
              gradingScale: fromStoredScale(data.grading_scale) })
          } else if (error?.code === '23505') {
            // Raced with an existing row; adopt it rather than duplicating.
            const { data: found } = await supabase
              .from('gpa_institutions').select('id, name, credit_system, grading_scale')
              .eq('user_id', userId).ilike('name', spec.name).maybeSingle()
            if (found) liveInstitutions.push({ id: found.id, name: found.name, creditSystem: found.credit_system,
              gradingScale: fromStoredScale(found.grading_scale) })
          }
        }

        // ---- D38 Phase 2: grading scales printed on the transcript itself.
        // Only institutions the model reported a legend for are touched, and
        // only in the direction the precedence rules allow.
        const scaleNotes: { actionable: boolean; text: string }[] = []
        const conflicts: ScaleConflict[] = []
        for (const d of detected as any[]) {
          const instId = byNameForScales(liveInstitutions, d?.name)
          if (!instId) continue
          const target = liveInstitutions.find(i => i.id === instId)!
          const ambiguity = String(d?.gradingScaleAmbiguity ?? '').trim()
          // D48: the points come from the deterministic legend parser. The
          // model only names which table applies, so it cannot alter a value
          // the document printed.
          const candidates = Array.isArray(legendTables) ? legendTables : []
          const chosen = candidates.find(
            (t: any) => String(t?.id) === String(d?.gradingScaleTableId ?? '')) ?? null
          if (!chosen) {
            // The message must describe what was actually found. Claiming
            // several grading systems on a transcript that prints none sends
            // the user looking for a page that does not exist.
            const note = legendNoteFor({
              institutionName: target.name, candidateCount: candidates.length,
              ambiguity, applied: false,
            })
            scaleNotes.push({ actionable: note.actionable, text: note.text })
            continue
          }
          const check = validateDetectedScale({
            points: chosen.points,
            evidence: Array.isArray(chosen.evidence) ? chosen.evidence.join('\n') : String(chosen.evidence ?? ''),
            applicability: String(d?.gradingScaleApplicability ?? chosen.caption ?? ''),
          })
          if (!check.ok) { scaleNotes.push({ actionable: true, text: `${target.name}: ${check.reason} No scale was applied.` }); continue }

          const merge = planScaleMerge(target.gradingScale ?? null, check.scale)
          if (merge.action === 'set' && merge.next) {
            const { error: sErr } = await supabase.from('gpa_institutions')
              .update({ grading_scale: toStoredScale(merge.next) })
              .eq('id', instId).eq('user_id', userId)
            if (sErr) { scaleNotes.push({ actionable: true, text: `${target.name}: the detected grading scale could not be saved.` }); continue }
            target.gradingScale = merge.next
            // Success. Surfaced as a chip on the school, not as a panel.
            scaleNotes.push({ actionable: false, text: `${target.name}: grading scale detected from the transcript.` })
          } else if (merge.action === 'conflict') {
            conflicts.push({ institutionId: instId, institutionName: target.name, merge })
          } else if (merge.action === 'blocked-user') {
            scaleNotes.push({ actionable: true, text: `${target.name}: ${merge.message}` })
          }
        }
        setScaleConflicts(conflicts)
        // Held with the review, for the same reason: they describe this import,
        // and this import's analysis is chosen below.
        const pendingScaleNotes = scaleNotes

        setInstitutions(liveInstitutions)

        // name -> id, for the courses below
        const byName = new Map<string, string>()
        for (const inst of liveInstitutions) byName.set(normalizeName(inst.name), inst.id)
        const ambiguousNames = new Set(plan.ambiguous.map((a: { detectedName: string }) => normalizeName(a.detectedName)))

        const VALID_CATS = ['science', 'nursing', 'general']
        let coursesWithIds: Course[] = rawCourses.map((c: any) => {
          const instName = String(c?.institutionName ?? '').trim()
          const key = normalizeName(instName)
          const isAmbiguous = key !== '' && ambiguousNames.has(key)
          const institutionId = isAmbiguous ? null : (byName.get(key) ?? null)

          const reviewReasons: string[] = []
          if (isAmbiguous) {
            const why = plan.ambiguous.find((a: { detectedName: string; reason?: string }) => normalizeName(a.detectedName) === key)?.reason
            reviewReasons.push(why ?? `"${instName}" could not be matched to one of your schools.`)
          } else if (!institutionId) {
            reviewReasons.push('The school for this course could not be determined. Assign it below.')
          }
          if (c?.needsReview === true && c?.reviewReason) reviewReasons.push(String(c.reviewReason).slice(0, 200))

          const level = c?.level === 'graduate' || c?.level === 'undergraduate' ? c.level : 'unknown'
          if (level === 'unknown') reviewReasons.push('Academic level was not stated on the transcript.')

          // D1: the receiving school's acknowledgement is never a second attempt.
          const recordType = c?.recordType === 'transfer_notation' ? 'transfer_notation' : 'coursework'

          return {
            id: `c-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            institutionId,
            courseCode: c?.courseCode ? String(c.courseCode).slice(0, 40) : null,
            name: String(c?.name ?? '').slice(0, 200),
            grade: String(c?.grade ?? ''),
            credits: normalizeCredits(c?.credits) ?? 0,
            year: c?.year ? String(c.year).slice(0, 10) : '',
            term: c?.term ? String(c.term).slice(0, 20) : '',
            categories: Array.isArray(c?.categories) && c.categories.length
              ? c.categories.filter((x: any) => VALID_CATS.includes(x))
              : ['general'],
            categorySource: 'ai' as const,
            level: level as any,
            levelSource: 'ai' as const,
            recordType: recordType as any,
            transferredIn: c?.transferredIn === true,
            // D50: a notation's originating school, kept as printed. It is NOT
            // this row's institution -- the notation belongs to the receiving
            // school -- but without it the originating coursework can never be
            // recognised once both transcripts sit in one analysis.
            transferredFromName: recordType === 'transfer_notation' && c?.transferredFromName
              ? String(c.transferredFromName).slice(0, 120).trim() || null
              : null,
            // D60: server-issued provenance, so this row is still recognisably
            // transcript coursework after editing, copying and combining.
            transcriptSourceId,
            needsReview: reviewReasons.length > 0,
            reviewReasons,
          }
        })

        // D51: the document's own transfer-credit sections decide record type,
        // not the model. A row the transcript prints inside a transfer block is
        // a notation whether or not it repeats a TR marker, and whether or not
        // it prints a grade at all -- the same PDF used to classify its two
        // blank-grade rows differently on different runs. Grades are preserved
        // exactly as extracted; only the record type and the originating school
        // are established here.
        const sectioned = applyTransferSections(coursesWithIds, text)
        coursesWithIds = sectioned.courses as Course[]
        if (sectioned.converted.length > 0 || sectioned.originsFilled > 0) {
          console.info('gpa.import.transferSections', JSON.stringify({
            converted: sectioned.converted.length, originsFilled: sectioned.originsFilled,
          }))
        }

        // D42/D56: the transcript's own subject and title evidence decides the
        // categories, in both directions. Run before dedupe so both import
        // paths get the same classification, and after the transfer sections so
        // it sees final record types.
        const reclassified = applyCategoryClassification(coursesWithIds)
        coursesWithIds = reclassified.courses
        const nursingSubjectNotes = reclassified.changed

        // Duplicate protection: re-uploading the same transcript must not
        // silently double someone's coursework. Institution and course code
        // participate in the key so the same code at two schools stays distinct,
        // and so an originating course and its transfer notation never collide.
        const key = (c: Course) => [
          String(c.institutionId ?? ''),
          String(c.recordType ?? 'coursework'),
          String(c.courseCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
          String(c.name ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
          String(normalizeCredits(c.credits) ?? ''),
          String(c.year ?? '').trim(),
          String(c.term ?? '').trim().toLowerCase(),
        ].join('|')

        // D36: deterministic name from the institutions we actually detected.
        const namesIn = (rows: Course[]) => [...new Set(
          rows.map(c => c.institutionId
            ? liveInstitutions.find(i => i.id === c.institutionId)?.name
            : null).filter(Boolean) as string[])]

        push(advance(st, 'importing'))

        /**
         * One place where an import is declared finished, so metrics, the retry
         * handle and the notices are never left behind by one of the branches.
         *
         * D54: the analysis id is what every notice from this import is scoped
         * to. It is only known here, once the destination has been decided.
         */
        const finish = (imported: number, analysisId: string | null) => {
          push(succeed(st, Date.now()))
          pendingImport.current = null
          // D60: the allowance is now spent server-side. Reflected here so the
          // next click opens the upgrade prompt instead of a file picker.
          if (transcriptSourceId) setTranscriptUsed(true)
          recordImport(importMetrics(st, Date.now(), {
            courses: imported, pages: numPages, promptTokens, completionTokens,
          }))
          setImportReview(pendingReview ? scopedTo(analysisId, pendingReview) : null)
          setScaleNotes(pendingScaleNotes.length > 0 ? scopedTo(analysisId, pendingScaleNotes) : null)
        }

        /** What the import did, in-app. Success never interrupts with a dialog. */
        const summaryLines = (rows: Course[]) => {
          const byInstitution = new Map<string, number>()
          for (const c of rows) {
            if (!c.institutionId) continue
            const label = liveInstitutions.find(i => i.id === c.institutionId)?.name ?? 'Unknown school'
            byInstitution.set(label, (byInstitution.get(label) ?? 0) + 1)
          }
          const lines = [...byInstitution.entries()].map(([n, count]) => `${n} — ${count} course(s)`)
          const needsAssignment = rows.filter(c => !c.institutionId).length
          if (needsAssignment > 0) lines.push(`${needsAssignment} course(s) still need a school.`)
          if (nursingSubjectNotes.length > 0) {
            // What the transcript's own subject and title evidence changed,
            // named in the direction it moved so nothing looks arbitrary.
            const describe = (n: typeof nursingSubjectNotes[number]) => {
              const moves = [
                ...n.added.map(c => `+${c}`),
                ...n.removed.map(c => `−${c}`),
              ].join(' ')
              return `${n.courseName} (${moves})`
            }
            lines.push(
              `${nursingSubjectNotes.length} course(s) categorized from the transcript's own subject ` +
              `code and title rather than by subject matter: ` +
              nursingSubjectNotes.slice(0, 5).map(describe).join(', ') +
              (nursingSubjectNotes.length > 5 ? `, and ${nursingSubjectNotes.length - 5} more` : ''))
          }
          lines.push('Review the grades and credits below before relying on your GPA.')
          return lines
        }

        if (destination === 'combine') {
          // D47: the transcript was analyzed once, just now. The open analysis
          // is NOT re-analyzed -- its coursework is already structured, so it
          // is simply copied into the new analysis, and it does not change.
          const existing = new Set(courses.map(key))
          const fresh = coursesWithIds.filter(c => !existing.has(key(c)))
          const dupes = coursesWithIds.length - fresh.length
          if (fresh.length === 0) {
            finish(0, currentId)
            setCombineError({
              title: 'Nothing new on this transcript',
              message: `Every course on this transcript already appears in ` +
                `“${current?.name ?? 'this analysis'}”, so combining them would only duplicate ` +
                `coursework. No analysis was created.`,
            })
            setCombineMode('with')
            return
          }
          const plan = planCombineWithNewCourses({
            current: { id: currentId ?? '', name: current?.name ?? '', courses, policies },
            incoming: fresh, incomingNames: namesIn(fresh),
            existingAnalyses: analyses, institutions: liveInstitutions,
            canCreate: canCreateAnalysis(analyses),
          })
          if (!plan.ok) {
            finish(0, currentId)
            setCombineError({ title: plan.title, message: plan.message! })
            setCombineMode('with')
            return
          }
          const combined = await createAnalysis(plan.name, {
            courses: plan.courses!, policies: plan.policies!,
          })
          // Nothing destroyed: the sources were only ever read.
          if (!combined) throw new ImportError('limit')
          finish(fresh.length, combined.id)
          setImportFlash(scopedTo(combined.id, fresh.length))
          setImportNote(scopedTo(combined.id, {
            title: 'Transcript analyzed',
            lines: [
              `Created “${combined.name}” with ${plan.courses!.length} course(s)` +
              (dupes > 0 ? ` (${dupes} row(s) already present in the copy were skipped)` : '') +
              `. Your original analyses are unchanged.`,
              ...summaryLines(fresh),
            ],
          }))
          return
        }

        if (destination === 'separate') {
          // A standalone analysis. What is open plays no part in it, so its
          // coursework is not deduplicated against either.
          const created = await createAnalysis(
            analysisNameFromInstitutions(namesIn(coursesWithIds)),
            { courses: coursesWithIds, policies: DEFAULT_POLICIES })
          if (!created) throw new ImportError('limit')
          finish(coursesWithIds.length, created.id)
          setImportFlash(scopedTo(created.id, coursesWithIds.length))
          setImportNote(scopedTo(created.id, {
            title: 'Transcript analyzed',
            lines: [
              `Created “${created.name}” with ${coursesWithIds.length} course(s). ` +
              `Your original analyses are unchanged.`,
              ...summaryLines(coursesWithIds),
            ],
          }))
          return
        }

        // 'fill': the open analysis is empty, so the transcript simply fills it
        // in. Nothing existing can be lost, and no second analysis is worth
        // making.
        const fresh = coursesWithIds
        if (fresh.length > MAX_DRAFT_COURSES) {
          throw new ImportError('too-large',
            `This transcript holds ${fresh.length} courses, more than one analysis can hold.`)
        }

        // D61: there may be no analysis to fill.
        //
        // An account that holds none -- a brand-new user whose first action is
        // an upload -- has currentId === null, and 'fill' was still chosen
        // because an account with no analyses also has no courses. The branch
        // below then wrote 34 rows into React state and scoped every notice to
        // a null id: the coursework looked imported, persisted nowhere, and was
        // gone on the next page load. The institution row survived, so the
        // transcript had genuinely been read -- only its coursework was lost.
        //
        // The analysis is created HERE rather than before the import, so a
        // parser or analyzer failure still leaves no empty analysis behind.
        // Seeded at creation, exactly as 'separate' does, so the coursework is
        // written by the same insert that makes the row -- there is no window
        // in which an analysis exists without its courses.
        if (!currentId) {
          const created = await createAnalysis(
            analysisNameFromInstitutions(namesIn(fresh)),
            { courses: fresh, policies: DEFAULT_POLICIES })
          if (!created) throw new ImportError('limit')
          finish(fresh.length, created.id)
          setImportFlash(scopedTo(created.id, fresh.length))
          setImportNote(scopedTo(created.id, {
            title: 'Transcript analyzed', lines: summaryLines(fresh),
          }))
          return
        }

        // D36: an analysis nobody has named takes the name of the school its
        // transcript came from. It runs here, once, after the institutions have
        // been resolved to real rows -- never from raw analyzer text, and never
        // as a first guess that has to be corrected afterwards. A name the user
        // typed themselves is left exactly as they typed it.
        const smart = smartAnalysisName({
          currentName: current?.name,
          institutionNames: namesIn(fresh),
          otherAnalyses: analyses.filter(a => a.id !== currentId),
        })
        if (smart) await renameAnalysis(currentId, smart)

        setCourses(prev => [...prev, ...fresh])
        finish(fresh.length, currentId)
        setImportFlash(scopedTo(currentId, fresh.length))
        setImportNote(scopedTo(currentId, { title: 'Transcript analyzed', lines: summaryLines(fresh) }))

      } else {
        throw new ImportError('unreadable', 'No coursework could be read from that transcript.')
      }
    } catch (error: any) {
      // Every failure lands here as a classified kind, so the user is told what
      // actually went wrong instead of being handed the same generic sentence.
      const kind: FailureKind = error instanceof ImportError
        ? error.kind
        : classifyFailure({ name: error?.name, message: error?.message })
      console.error('transcript import failed:', kind)
      // D60: a spent allowance is not a broken transcript. The user is shown
      // the upgrade path, and the local flag is corrected so the next attempt
      // does not have to reach the server to find out.
      if (kind === 'allowance-used') { setTranscriptUsed(true); setLimitModal(true) }
      push(fail(st, kind, Date.now()))
      recordImport(importMetrics(st, Date.now(), {
        pages: numPages, promptTokens, completionTokens,
      }))
    }
  }

  const saveCalculation = async () => {
    if (saving) return
    if (!userId) {
      alert('Please log in to save calculations')
      return
    }

    if (!calculationName.trim()) {
      alert('Please enter a name for this calculation')
      return
    }

    const calculation = {
      user_id: userId,
      calculation_name: calculationName,
      courses: courses,
      science_gpa: results.science.value,
      overall_gpa: results.overall.value,
      last60_gpa: results.last60.value,
      nursing_gpa: results.nursing.value,
      graduate_gpa: results.graduate.value,
      engine_version: ENGINE_VERSION,
      policies,
      institutions,
    }

    setSaving(true)
    try {
      const { error } = await supabase.from('gpa_calculations').insert(calculation)
      if (error) {
        alert('❌ Could not save: ' + error.message)
        return
      }

      const { data: calcs } = await supabase
        .from('gpa_calculations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
      if (calcs) setSavedCalculations(calcs)

      alert('✅ Calculation saved successfully!')
      setCalculationName('')
    } finally {
      setSaving(false)
    }
  }

  /** D10: selecting a saved calculation only opens it for viewing. */
  const viewCalculation = (calc: any) => setViewingCalc(calc)

  /**
   * D10: the only path from a saved snapshot into the working draft, and it is
   * explicit. A non-empty draft is never replaced without confirmation. The
   * saved row itself is never modified -- it stays a historical snapshot.
   */
  /**
   * D33: a saved snapshot never overwrites an analysis. It becomes a NEW
   * editable analysis, so nothing existing can be destroyed by loading one.
   * The snapshot row itself is never modified.
   */
  const loadCalculationIntoDraft = async (calc: any) => {
    // Rows written before V2 carry engine_version NULL and hold V1-shaped
    // courses. Adapt them for display only; the stored row is never rewritten.
    const isLegacy = (calc.engine_version ?? 1) < 2
    const snapshotCourses = isLegacy ? upgradeCourses(calc.courses) : (calc.courses || [])
    // D21: a V1 row's behavior was a code path, not a choice this user made,
    // so the new analysis starts with both policies unchosen.
    const snapshotPolicies = isLegacy
      ? DEFAULT_POLICIES : { ...DEFAULT_POLICIES, ...(calc.policies || {}) }

    const created = await createAnalysis(
      `${String(calc.calculation_name ?? 'Saved calculation').trim()} (copy)`,
      { courses: snapshotCourses, policies: snapshotPolicies }
    )
    setViewingCalc(null)
    if (created) {
      alert(`✅ Created editable analysis "${created.name}".\n\nThe saved calculation itself is unchanged.`)
    }
  }

  const exportToPDF = () => {
    const dash = '\u2014'
    const gpas = {
      science: results.science.display ?? dash,
      overall: results.overall.display ?? dash,
      last60: results.last60.display ?? dash,
      nursing: results.nursing.display ?? dash,
    }

    const doc = new jsPDF()
    
    doc.setFontSize(20)
    doc.text('GPA CALCULATION REPORT', 20, 20)
    
    doc.setFontSize(12)
    doc.text(calculationName || 'Unnamed Calculation', 20, 30)
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 20, 37)
    
    doc.setFontSize(16)
    doc.text('SUMMARY', 20, 50)
    
    doc.setFontSize(12)
    doc.text(`Science GPA: ${gpas.science}`, 20, 60)
    doc.text(`Overall GPA: ${gpas.overall}`, 20, 67)
    doc.text(`Last 60 Credits: ${gpas.last60}`, 20, 74)
    doc.text(`Nursing GPA: ${gpas.nursing}`, 20, 81)
    
    doc.setFontSize(10)
    doc.text('(Transfer courses excluded from calculations)', 20, 88)
    
    doc.setFontSize(16)
    doc.text(`COURSE BREAKDOWN (${courses.length} courses)`, 20, 100)
    
    doc.setFontSize(10)
    let yPos = 110
    courses.forEach((c, i) => {
      if (yPos > 270) {
        doc.addPage()
        yPos = 20
      }
      const transfer = c.recordType === 'transfer_notation' ? ' [NOTATION - never counted]'
        : c.transferredIn ? ' [TRANSFERRED IN]' : ''
      doc.text(`${i + 1}. ${c.name}${transfer}`, 20, yPos)
      doc.text(`Grade: ${c.grade} | Credits: ${c.credits} | Categories: ${c.categories.join(', ')}`, 30, yPos + 5)
      if (c.year || c.term) {
        doc.text(`${c.term || ''} ${c.year || ''}`, 30, yPos + 10)
        yPos += 15
      } else {
        yPos += 12
      }
    })
    
    doc.save(`GPA-Calculation-${new Date().toISOString().split('T')[0]}.pdf`)
  }

  // ---------------------------------------------------------------- workspace
  // Level 1 (analysis + results) stays pinned above; Levels 2 and 3 share the
  // tab panel below, so configuration no longer costs permanent screen height.
  const tabs: TabSpec[] = [
    { id: 'courses', label: 'Courses', icon: <ClipboardList className="h-4 w-4" />, badge: courses.length },
    { id: 'schools', label: 'Schools & Grading', icon: <School className="h-4 w-4" />, badge: usedInstitutions.length },
    { id: 'policies', label: 'Policies', icon: <Scale className="h-4 w-4" />,
      // A pending policy IS a required setup item, so the tab wears the same
      // colour the required card does. It disappears entirely once resolved.
      badge: policyAttention, badgeTone: policyAttention > 0 ? 'danger' : 'warn' },
    { id: 'saved', label: 'Saved', icon: <Layers className="h-4 w-4" />, badge: savedCalculations.length },
  ]

  /**
   * Leaving really does lose the analysis: the request lives in this page, and
   * nothing resumes it. The panel says so in-app the whole time; this is the
   * only case an in-app message cannot cover, because the page is going away.
   */
  useEffect(() => {
    if (importState.phase !== 'running') return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [importState.phase])

  /** The success confirmation is brief by design; the workspace is the point. */
  useEffect(() => {
    if (importFlash === null) return
    const id = setTimeout(() => setImportFlash(null), 6000)
    return () => clearTimeout(id)
  }, [importFlash])

  /**
   * D54: moving to another analysis leaves its notices behind for good.
   *
   * Scoping alone would only hide them, so switching back would resurrect a
   * message the user had already read and moved past. Dropping alone would race
   * with the notice a newly created combined analysis posts about itself --
   * that one arrives just after the switch it belongs to, and survives here
   * because it names the analysis now open.
   */
  useEffect(() => {
    setImportFlash(n => dropIfForeign(n, currentId))
    setImportNote(n => dropIfForeign(n, currentId))
    setCombineNotice(n => dropIfForeign(n, currentId))
    setImportReview(n => dropIfForeign(n, currentId))
    setScaleNotes(n => dropIfForeign(n, currentId))
  }, [currentId])

  const openTranscriptPicker = () => {
    // Duplicate protection at the source: while one transcript is being
    // analyzed, no path can open the picker and start a second AI call.
    if (!canStartImport(importState)) return
    if (!canUploadTranscript) { setLimitModal(true); return }
    setMode('ai')
    // The input lives in the hidden uploader below; clicking it keeps the whole
    // upload path (parse, analyze, dedupe, Start New vs Add to Current) intact.
    requestAnimationFrame(() => document.getElementById('transcript-upload')?.click())
  }

  return (
    <div className="flex min-h-screen bg-[#F7F8FC]">
      {/* min-w-0: without it this flex item keeps min-width:auto, so the
          tab strip's intrinsic width wins over its own overflow-x-auto and
          the whole page scrolls sideways on a phone. */}
      <div className={`min-w-0 flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-8">

          {/* The file input is always mounted so the compact "Add Transcript"
              action and the empty state can both drive it. */}
          <input type="file" accept=".pdf" id="transcript-upload" className="hidden"
            onChange={handleTranscriptUpload} disabled={analyzing} />

          {/* ------------------------------------------------ workspace header */}
          <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <GraduationCap className="h-5 w-5 text-violet-600" aria-hidden />
                <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">GPA Analyzer</h1>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {isLoggedIn && analyses.length > 0 ? (
                  <>
                    <div className="relative">
                      <select
                        aria-label="Current analysis"
                        value={currentId ?? ''}
                        onChange={e => {
                          const a = analyses.find(x => x.id === e.target.value)
                          if (a) selectAnalysis(a)
                        }}
                        className="max-w-[16rem] cursor-pointer appearance-none truncate rounded-lg bg-transparent py-0.5 pl-0 pr-6 text-sm font-semibold text-slate-700 outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-violet-400 sm:max-w-xs">
                        {analyses.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.name} — {a.courses.length} course{a.courses.length === 1 ? '' : 's'}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                    </div>
                    <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block" aria-hidden />
                    <SaveStatus state={saveState} onRetry={retrySave} />
                    <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block" aria-hidden />
                    <button onClick={handleRename} disabled={!current} className={`${BTN_GHOST} !px-1.5 !text-xs`}>
                      Rename
                    </button>
                    <button onClick={() => currentId && deleteAnalysis(currentId)} disabled={!current}
                      className={`${BTN_GHOST} !px-1.5 !text-xs hover:!text-rose-600`}>
                      Delete
                    </button>
                    <button onClick={() => setNewAnalysisAsk(true)}
                      className={`${BTN_GHOST} !px-1.5 !text-xs !text-violet-700 hover:!bg-violet-50`}>
                      <Plus className="h-3.5 w-3.5" aria-hidden />New
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">
                    Science, Overall, Last 60 and Nursing GPAs from your transcripts.
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* D60: the badge marks a spent allowance, not a plan. Free and
                  Premium reach the real button for their first transcript. */}
              {canUploadTranscript ? (
                <button onClick={openTranscriptPicker} disabled={analyzing} className={BTN_SECONDARY}
                  title={blockedUploadReason(importState) ?? undefined}
                  aria-describedby={analyzing ? 'import-busy' : undefined}>
                  {analyzing
                    ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />Analyzing…</>
                    : <><Upload className="h-4 w-4" aria-hidden />Add Transcript</>}
                </button>
              ) : (
                <button onClick={openTranscriptPicker} className={`${BTN_SECONDARY} !text-slate-500`}>
                  <Upload className="h-4 w-4" aria-hidden />Add Transcript
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
                    Ultimate
                  </span>
                </button>
              )}
              {analyzing && (
                <span id="import-busy" className="text-xs font-medium text-violet-700">
                  {blockedUploadReason(importState)}
                </span>
              )}
              {analyses.length > 1 && (
                <button onClick={() => setCombineMode('with')} className={BTN_SECONDARY}>
                  <Layers className="h-4 w-4" aria-hidden />Combine with Existing
                </button>
              )}
              <button onClick={addCourse} className={BTN_SECONDARY}>
                <Plus className="h-4 w-4" aria-hidden />Add Course
              </button>
              {courses.length > 0 && (
                <>
                  <button onClick={() => setActiveTab('saved')} className={BTN_SECONDARY}>
                    <Save className="h-4 w-4" aria-hidden />Save Snapshot
                  </button>
                  <button onClick={exportToPDF} className={BTN_PRIMARY}>
                    <FileDown className="h-4 w-4" aria-hidden />Export PDF
                  </button>
                </>
              )}
              {!isLoggedIn && (
                <Link href="/login" className={BTN_PRIMARY}>Login</Link>
              )}
            </div>
          </header>

          {/* ------------------------------------ Level 0: an import in flight */}
          {(importState.phase === 'running' || importState.phase === 'error') && (
            <ImportProgress
              state={importState}
              onRetry={retryImport}
              onChooseAnother={() => { setImportState(IDLE_IMPORT); openTranscriptPicker() }}
              onDismiss={() => setImportState(IDLE_IMPORT)} />
          )}
          {/* D54: each notice renders only on the analysis it is about. */}
          {noticeFor(importFlash, currentId) !== null && (
            <ImportSuccessFlash courses={noticeFor(importFlash, currentId)!} />
          )}

          {/* --------------------------------------------- Level 1: the results */}
          {courses.length > 0 ? (
            <div className="mb-5">
              <GpaHero results={results} hasGraduate={hasGraduate} blocked={blockedPending}
                pending={heroPending} requiredCount={setupState.required.length} />
            </div>
          ) : importState.phase === 'running' || importState.phase === 'error' ? null : (
            /* Empty analysis: one polished upload moment instead of a permanent
               dashed panel that never shrinks. */
            <div className={`${CARD} mb-5 px-6 py-12 text-center sm:py-16`}>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50">
                <FileText className="h-6 w-6 text-violet-600" aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-bold tracking-tight text-slate-900">
                Upload your transcript
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
                Automatically extract coursework, institutions, categories and grading information.
                You can also add courses by hand.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <button onClick={openTranscriptPicker} className={BTN_PRIMARY}>
                  <Upload className="h-4 w-4" aria-hidden />Choose Transcript
                </button>
                <button onClick={addCourse} className={BTN_SECONDARY}>
                  <Plus className="h-4 w-4" aria-hidden />Add course manually
                </button>
              </div>
              {/* D60: worded from the entitlement. Someone who deleted the
                  analysis still has no transcript left, so "you already have
                  one" would be false and "delete one" would be destructive
                  advice that changes nothing. */}
              {!isUltimate && (
                <p className="mt-4 text-xs text-slate-500">
                  {transcriptUsed === true
                    ? 'You’ve already used your transcript analysis. Manual entry is available on every plan.'
                    : 'Your plan includes one transcript analysis. Manual entry is available on every plan.'}
                </p>
              )}
            </div>
          )}

          {newAnalysisAsk && (
            <NewAnalysisModal canCombine={analyses.length >= 2}
              onChoose={kind => {
                setNewAnalysisAsk(false)
                if (kind === 'blank') createAnalysis()
                else if (kind === 'upload') openTranscriptPicker()
                else if (kind === 'combine') setCombineMode('new')
              }} />
          )}

          {combineMode && (
            <CombineModal
              mode={combineMode}
              /* 'with' already contributes the open analysis, so it is not
                 offered again in the list. */
              analyses={combineMode === 'with' ? analyses.filter(a => a.id !== currentId) : analyses}
              institutions={institutions}
              currentName={current?.name}
              error={combineError?.message ?? null} errorTitle={combineError?.title ?? null}
              busy={combining}
              onCancel={() => { setCombineMode(null); setCombineError(null) }}
              onConfirm={ids => { setCombineError(null); createCombined(ids) }} />
          )}

          {destinationAsk && (
            <DestinationModal
              analysisName={current?.name}
              onChoose={choice => { destinationAsk.resolve(choice); setDestinationAsk(null) }} />
          )}

          {/* D60: the one transcript is spent. Shown from either entry point --
              a click that never reached a file picker, and a server refusal of
              an upload that did. */}
          {limitModal && <TranscriptLimitModal onClose={() => setLimitModal(false)} />}

          {/* ------------------------------------------ decisions and setup */}
          {/* A merge conflict is a genuine two-version decision, not a setup
              step, so it keeps its own surface above everything else. */}
          {conflicts.length > 0 && (
            <div className={`${CARD} mb-5 border-amber-300 p-4 sm:p-5`}>
              <h2 className="text-sm font-bold text-slate-900">
                {conflicts.length} conflicting change{conflicts.length === 1 ? '' : 's'}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                This analysis was edited in another tab or on another device at the same time as here.
                Everything that did not clash has already been merged. Choose which version to keep —
                <strong className="font-semibold"> nothing is saved until you do.</strong>
              </p>
              <div className="mt-3 space-y-2">
                {conflicts.map(c => {
                  const describe = (v: any) => {
                    if (v === null) return 'Deleted'
                    if (typeof v === 'string') return v === 'include' ? 'Include'
                      : v === 'exclude' ? 'Exclude'
                      : v === 'both' ? 'Count both attempts'
                      : v === 'latest' ? 'Count latest only' : String(v)
                    return `${v.name || 'Untitled'} — grade ${v.grade}, ${v.credits} cr`
                  }
                  const choice = conflictChoices[c.id]
                  const opt = (side: 'mine' | 'theirs') =>
                    `rounded-xl border px-3 py-2 text-left text-sm transition ${
                      choice === side ? 'border-violet-600 bg-violet-600 font-semibold text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`
                  return (
                    <div key={c.id} className="rounded-xl border border-slate-200 p-3">
                      <p className="text-sm font-semibold text-slate-800">
                        {c.label}
                        <span className="ml-2 text-xs font-normal text-slate-500">
                          {c.kind === 'policy-both-changed' ? 'setting changed in both places'
                            : c.kind === 'course-deleted-vs-edited' ? 'deleted in one place, edited in the other'
                            : 'edited in both places'}
                        </span>
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <button onClick={() => setConflictChoices({ ...conflictChoices, [c.id]: 'mine' })}
                          className={opt('mine')}>
                          <span className="block text-xs opacity-75">This tab</span>{describe(c.mine)}
                        </button>
                        <button onClick={() => setConflictChoices({ ...conflictChoices, [c.id]: 'theirs' })}
                          className={opt('theirs')}>
                          <span className="block text-xs opacity-75">Other tab / device</span>{describe(c.theirs)}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <button onClick={() => { resolve(conflictChoices); setConflictChoices({}) }}
                disabled={conflicts.some(c => !conflictChoices[c.id])}
                className={`${BTN_PRIMARY} mt-3 w-full`}>
                {conflicts.some(c => !conflictChoices[c.id])
                  ? `Choose a version for all ${conflicts.length} item(s)`
                  : 'Save resolved draft'}
              </button>
            </div>
          )}

          {/* A scale disagreement is also a decision with two real answers, so
              it stays its own notice. The "scale detected" success message does
              NOT — that is now a chip inside the setup card. */}
          {scaleConflicts.map(c => (
            <div key={c.institutionId} className="mb-5">
              <Notice title={`${c.institutionName} — grading scale conflict`}
                actions={<>
                  <button onClick={() => resolveScaleConflict(c.institutionId, 'detected')}
                    className={`${BTN_PRIMARY} !px-3 !py-1.5 !text-xs`}>Use the scale on this transcript</button>
                  <button onClick={() => resolveScaleConflict(c.institutionId, 'existing')}
                    className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>Keep the existing scale</button>
                </>}>
                <p>{c.merge.message}</p>
                <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <dt className="text-xs font-semibold text-slate-700">Already detected</dt>
                    <dd className="mt-0.5 text-xs tabular-nums text-slate-600">{scaleSummary(c.merge.current?.points)}</dd>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <dt className="text-xs font-semibold text-slate-700">On this transcript</dt>
                    <dd className="mt-0.5 text-xs tabular-nums text-slate-600">{scaleSummary(c.merge.next?.points)}</dd>
                    {c.merge.detected?.evidence && (
                      <dd className="mt-1 text-xs italic text-slate-400">
                        “{c.merge.detected.evidence.slice(0, 200)}”
                      </dd>
                    )}
                  </div>
                </dl>
              </Notice>
            </div>
          ))}

          {/* Anything the import could not apply on its own. Purely detected
              scales are reported by the setup card's chip instead. */}
          {actionableScaleNotes.length > 0 && (
            <div className="mb-5">
              <Notice tone="info" title="Grading scales">
                <ul className="list-disc space-y-1 pl-4">
                  {actionableScaleNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </Notice>
            </div>
          )}

          {/* D44 last resort: automatic reconciliation and its retry both failed,
              so the import is not presented as complete. */}
          {noticeFor(combineNotice, currentId) && (
            <div className="mb-5">
              <Notice tone="info" title="New analysis created"
                actions={
                  <button onClick={() => setCombineNotice(null)}
                    className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>Dismiss</button>
                }>
                {noticeFor(combineNotice, currentId)}
              </Notice>
            </div>
          )}

          {noticeFor(importNote, currentId) && (
            <div className="mb-5">
              <Notice tone="info" title={noticeFor(importNote, currentId)!.title}
                actions={
                  <button onClick={() => setImportNote(null)}
                    className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>Dismiss</button>
                }>
                <ul className="list-disc space-y-1 pl-4">
                  {noticeFor(importNote, currentId)!.lines.map((l: string, i: number) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}

          {noticeFor(importReview, currentId) && (
            <div className="mb-5">
              <Notice tone="warn" title="We couldn’t confidently read the full transcript"
                actions={
                  <button onClick={() => { setActiveTab('courses'); setImportReview(null) }}
                    className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>Review coursework</button>
                }>
                <p>{noticeFor(importReview, currentId)!.message}</p>
                <ul className="mt-2 space-y-0.5">
                  {noticeFor(importReview, currentId)!.checks.filter(c => !c.ok).map(c => (
                    <li key={c.name} className="text-sm">
                      <span className="font-medium text-slate-700">{c.name}</span>
                      <span className="text-slate-400"> · </span>
                      <span className="text-slate-600">
                        transcript prints {c.printed}, we read {c.computed}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">
                  Your GPA below is calculated only from the coursework we could read. Check the
                  course list against your transcript before relying on it.
                </p>
              </Notice>
            </div>
          )}

          {courses.length > 0 && (
            <div className="mb-5">
              <SetupCard
                state={setupState} courseCount={courses.length}
                institutions={institutions}
                policies={policies} setPolicies={setPolicies}
                setInstitutionCreditSystem={setInstitutionCreditSystem}
                unassigned={unassigned} selectedIds={selectedIds}
                toggleSelected={toggleSelected} setSelectedIds={setSelectedIds}
                assignTargetId={assignTargetId} setAssignTargetId={setAssignTargetId}
                assignSelectedTo={assignSelectedTo} addInstitution={addInstitution}
                onReviewCourses={() => setActiveTab('courses')}
                courses={courses} chooseTransferLink={chooseTransferLink} />
            </div>
          )}

          {/* --------------------------------------- Levels 2 and 3: the tabs */}
          <div className={`${CARD} p-1.5 sm:p-2`}>
            <div className="px-2 sm:px-3">
              <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
            </div>
            <div className="p-2 sm:p-3">
              <TabPanel id="courses" active={activeTab}>
                <CoursesPanel
                  courses={courses} institutions={institutions}
                  editingId={editingId} setEditingId={setEditingId}
                  notInScaleIds={notInScaleIds}
                  updateCourse={updateCourse} toggleCategory={toggleCategory}
                  removeCourse={removeCourse} addCourse={addCourse}
                  onAddTranscript={openTranscriptPicker} canUpload={canUploadTranscript}
                  uploadBusy={blockedUploadReason(importState)}
                  chooseTransferLink={chooseTransferLink}
                  newCourseId={newCourseId} clearNewCourse={() => setNewCourseId(null)}
                  replaceCourse={replaceCourse} />
              </TabPanel>

              <TabPanel id="schools" active={activeTab}>
                <SchoolsPanel
                  institutions={usedInstitutions}
                  otherInstitutions={unusedInstitutions}
                  totalCourses={courses.length}
                  scaleEditorId={scaleEditorId} setScaleEditorId={setScaleEditorId}
                  editInstitution={editInstitution} commitInstitution={commitInstitution}
                  removeInstitution={removeInstitution} addInstitution={addInstitution} />
              </TabPanel>

              <TabPanel id="policies" active={activeTab}>
                <PoliciesPanel policies={policies} setPolicies={setPolicies}
                  retakeUnresolved={retakeUnresolved} />
              </TabPanel>

              <TabPanel id="saved" active={activeTab}>
                <SavedPanel
                  savedCalculations={savedCalculations} viewingCalc={viewingCalc}
                  viewCalculation={viewCalculation} loadCalculationIntoDraft={loadCalculationIntoDraft}
                  calculationName={calculationName} setCalculationName={setCalculationName}
                  saveCalculation={saveCalculation} exportToPDF={exportToPDF}
                  saving={saving} isLoggedIn={isLoggedIn} canSnapshot={courses.length > 0} />
              </TabPanel>
            </div>
          </div>

          {courses.length > 0 && (
            <>
              {courses.some(c => c.transferredIn || c.recordType === 'transfer_notation') && (
                <p className="mt-4 text-xs leading-relaxed text-slate-500">
                  <strong className="font-semibold text-slate-600">
                    {courses.filter(c => c.transferredIn).length} transfer course(s)
                  </strong>{' '}
                  are handled by your transfer policy. For the most accurate result, upload the official
                  transcript from each institution you attended.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                {GPA_DISCLAIMER_D43}
                {retakeDisclaimer(policies, retakeUnresolved) && (
                  <> {retakeDisclaimer(policies, retakeUnresolved)}</>
                )}
              </p>
              {isLoggedIn && (
                <p className="mt-2 text-xs text-slate-400">
                  {analyses.length} of {MAX_ANALYSES_PER_USER} analyses. Each keeps its own coursework and
                  settings; your schools and saved snapshots are shared across all of them.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
