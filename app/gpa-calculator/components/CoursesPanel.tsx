'use client'

/**
 * The Courses tab - Level 2, the primary working surface.
 *
 * Two changes carry most of the weight here. Row actions collapse from a blue
 * Edit button plus a large red Delete button into one overflow menu, which
 * removes two saturated buttons per row from a list that is often 27 rows long.
 * And the category pills lose their emoji so a scan down the column reads as
 * data rather than decoration.
 */

import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { SELECTABLE_GRADES, type AcademicLevel, type Course, type CourseCategory, type Institution } from '@/lib/gpa'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from './workspace'

type UpdateCourse = (id: string, field: keyof Course, value: any, sourceField?: keyof Course) => void

/** Category / status pills. Colour is never the only signal - each has a word. */
function Pills({ course }: { course: Course }) {
  const pill = 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium'
  const onlyGeneral = course.categories.includes('general')
    && !course.categories.includes('science') && !course.categories.includes('nursing')
  return (
    <div className="flex flex-wrap gap-1">
      {course.recordType === 'transfer_notation' && (
        <span className={`${pill} bg-slate-100 text-slate-700`}>Notation</span>
      )}
      {course.transferredIn && (
        <span className={`${pill} bg-orange-50 text-orange-700`}>Transferred</span>
      )}
      {course.level === 'graduate' && (
        <span className={`${pill} bg-violet-50 text-violet-700`}>Graduate</span>
      )}
      {course.categories.includes('science') && (
        <span className={`${pill} bg-emerald-50 text-emerald-700`}>Science</span>
      )}
      {course.categories.includes('nursing') && (
        <span className={`${pill} bg-pink-50 text-pink-700`}>Nursing</span>
      )}
      {onlyGeneral && <span className={`${pill} bg-slate-100 text-slate-600`}>General</span>}
    </div>
  )
}

/** Edit / Delete behind one control, so a long list stays quiet. */
function RowMenu({ onEdit, onDelete, label }: { onEdit: () => void; onDelete: () => void; label: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div ref={box} className="relative flex justify-end">
      <button onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Actions for ${label}`}
        className={`${BTN_GHOST} h-8 w-8 !px-0`}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div role="menu"
          className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          <button role="menuitem" onClick={() => { setOpen(false); onEdit() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
            <Pencil className="h-3.5 w-3.5 text-slate-400" aria-hidden />Edit
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); onDelete() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50">
            <Trash2 className="h-3.5 w-3.5" aria-hidden />Delete
          </button>
        </div>
      )}
    </div>
  )
}

/** The full editor for one course. Shared by the table and the mobile cards. */
function CourseEditor({
  course, institutions, updateCourse, toggleCategory, onSave, onCancel, isNew,
  allCourses = [], chooseTransferLink,
}: {
  course: Course
  institutions: readonly Institution[]
  updateCourse: UpdateCourse
  toggleCategory: (id: string, c: CourseCategory) => void
  onSave: () => void
  onCancel: () => void
  /** A course added by hand and not yet kept. */
  isNew?: boolean
  /** D50: every row, so a transfer record can point at its original course. */
  allCourses?: readonly Course[]
  chooseTransferLink?: (notationId: string, courseId: string | null) => void
}) {
  const toggle = (on: boolean) =>
    `rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
      on ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`

  const missing: string[] = []
  if (!course.name.trim()) missing.push('a course name')
  if (!course.institutionId) missing.push('a school')
  if (!(Number(course.credits) > 0)) missing.push('credits above zero')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-slate-900">
          {isNew ? 'Add course' : 'Edit course'}
        </p>
        {missing.length > 0 && (
          /* Field-level guidance, not a refusal: the row is saved either way
             and the engine already reports what it cannot count. */
          <p className="text-xs text-amber-700">
            Add {missing.join(', ')} for this course to count toward your GPA.
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Course name</label>
          <input type="text" value={course.name} className={FIELD} placeholder="Course name"
            onChange={e => updateCourse(course.id, 'name', e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">
            Course code <span className="font-normal text-slate-400">— enables retake matching</span>
          </label>
          <input type="text" value={course.courseCode ?? ''} className={FIELD} placeholder="e.g. BIO 101"
            onChange={e => updateCourse(course.id, 'courseCode', e.target.value || null)} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Term</label>
          <input type="text" value={course.term || ''} className={FIELD} placeholder="Fall"
            onChange={e => updateCourse(course.id, 'term', e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Year</label>
          <input type="text" value={course.year || ''} className={FIELD} placeholder="2024"
            onChange={e => updateCourse(course.id, 'year', e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Grade</label>
          <select value={course.grade} className={FIELD}
            onChange={e => updateCourse(course.id, 'grade', e.target.value)}>
            {SELECTABLE_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Credits</label>
          <input type="number" min="0" max="24" step="0.5" value={course.credits} className={FIELD}
            onChange={e => updateCourse(course.id, 'credits', e.target.value === '' ? 0 : parseFloat(e.target.value))} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">School</label>
          <select value={course.institutionId ?? ''} className={FIELD}
            onChange={e => updateCourse(course.id, 'institutionId', e.target.value || null)}>
            <option value="">School: not set</option>
            {institutions.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600">Academic level</label>
          <select value={course.level} className={FIELD}
            onChange={e => updateCourse(course.id, 'level', e.target.value as AcademicLevel, 'levelSource')}>
            <option value="undergraduate">Undergraduate</option>
            <option value="graduate">Graduate</option>
            <option value="unknown">Level not set</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-600">Categories and handling</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={course.categories.includes('science')}
            onClick={() => toggleCategory(course.id, 'science')}
            className={toggle(course.categories.includes('science'))}>Science</button>
          <button type="button" aria-pressed={course.categories.includes('nursing')}
            onClick={() => toggleCategory(course.id, 'nursing')}
            className={toggle(course.categories.includes('nursing'))}>Nursing</button>
          <button type="button" aria-pressed={course.transferredIn}
            title="I took this course at another school and transferred it in"
            onClick={() => updateCourse(course.id, 'transferredIn', !course.transferredIn)}
            className={toggle(course.transferredIn)}>Transferred in</button>
          <button type="button" aria-pressed={course.recordType === 'transfer_notation'}
            title="This row is my school's transfer-credit notation, not the original graded course. Never counted."
            onClick={() => updateCourse(course.id, 'recordType',
              course.recordType === 'transfer_notation' ? 'coursework' : 'transfer_notation')}
            className={toggle(course.recordType === 'transfer_notation')}>Notation</button>
        </div>
      </div>

      {/* D50: a transfer record's link to the coursework it documents. Only a
          notation can carry one, and the user's choice outranks automation. */}
      {course.recordType === 'transfer_notation' && chooseTransferLink && (
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600" htmlFor={`link-${course.id}`}>
            Original course this record represents
            {course.transferredFromName && (
              <span className="font-normal text-slate-400"> — from “{course.transferredFromName}”</span>
            )}
          </label>
          <select id={`link-${course.id}`} className={FIELD}
            value={course.transferLink === undefined || course.transferLink === null
              ? '' : (course.transferLink.courseId ?? '__none__')}
            onChange={e => chooseTransferLink(course.id,
              e.target.value === '' || e.target.value === '__none__' ? null : e.target.value)}>
            <option value="">Not established</option>
            {allCourses
              .filter(c => c.recordType === 'coursework' && c.institutionId !== course.institutionId)
              .map(c => (
                <option key={c.id} value={c.id}>
                  {c.courseCode ? `${c.courseCode} — ` : ''}{c.name || 'Untitled'} ({c.credits} cr)
                </option>
              ))}
            <option value="__none__">Not in this analysis</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            This record never counts toward your GPA. The link decides whether the original course is
            governed by your transfer policy.
          </p>
        </div>
      )}

      {/* D59: an explicit end to the edit. Fields still write through as they
          change -- the autosave architecture is unchanged -- but the user is
          told when they are finished, and can back out of a mistake. */}
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <button onClick={onCancel} className={`${BTN_SECONDARY} !py-2.5`}>Cancel</button>
        <button onClick={onSave} className={`${BTN_PRIMARY} !py-2.5`}>Save course</button>
      </div>
    </div>
  )
}

export function CoursesPanel({
  courses, institutions, editingId, setEditingId, notInScaleIds,
  updateCourse, toggleCategory, removeCourse, addCourse, onAddTranscript, canUpload, uploadBusy,
  chooseTransferLink, newCourseId, clearNewCourse, replaceCourse,
}: {
  courses: Course[]
  institutions: readonly Institution[]
  editingId: string | null
  setEditingId: (id: string | null) => void
  notInScaleIds: Set<string>
  updateCourse: UpdateCourse
  toggleCategory: (id: string, c: CourseCategory) => void
  removeCourse: (id: string) => void
  addCourse: () => void
  onAddTranscript: () => void
  canUpload: boolean
  /** Set while a transcript is being analyzed, so a second one cannot start. */
  uploadBusy?: string | null
  /** D50: records the user's answer for one transfer record. */
  chooseTransferLink?: (notationId: string, courseId: string | null) => void
  /** D59: a course added by hand and not yet kept. */
  newCourseId?: string | null
  clearNewCourse?: () => void
  /** D59: restores a course wholesale, for Cancel. */
  replaceCourse?: (id: string, course: Course) => void
}) {
  /**
   * D59: what the course looked like when editing began.
   *
   * Fields write through as they are typed, which is the existing autosave
   * architecture and stays. Cancel puts this snapshot back, so backing out of
   * an edit is a real option rather than a manual undo of every field.
   */
  const [snapshot, setSnapshot] = useState<Course | null>(null)
  useEffect(() => {
    if (!editingId) { setSnapshot(null); return }
    const current = courses.find(c => c.id === editingId)
    setSnapshot(prev => (prev && prev.id === editingId ? prev : current ?? null))
    // Only when the edited course CHANGES: re-snapshotting on every keystroke
    // would capture the edits it exists to undo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const finishEdit = () => { setEditingId(null); clearNewCourse?.() }
  const cancelEdit = (course: Course) => {
    if (newCourseId && course.id === newCourseId) {
      // Nothing was kept, so nothing is left behind.
      removeCourse(course.id)
    } else if (snapshot && snapshot.id === course.id) {
      replaceCourse?.(course.id, snapshot)
    }
    finishEdit()
  }

  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? courses.filter(c =>
        (c.name ?? '').toLowerCase().includes(q) ||
        (c.courseCode ?? '').toLowerCase().includes(q))
    : courses

  const NotInScale = () => (
    <span title="This school's grading scale does not define this grade, so it is not counted. Add it to the scale under Schools &amp; Grading, or correct the grade."
      className="mt-1 inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
      Not in scale
    </span>
  )

  return (
    <div className={CARD}>
      {/* Toolbar */}
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-bold tracking-tight text-slate-900">
            {courses.length} {courses.length === 1 ? 'Course' : 'Courses'}
          </h2>
          {q && <span className="text-sm text-slate-500">· {shown.length} matching</span>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {courses.length > 6 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input type="search" value={query} onChange={e => setQuery(e.target.value)}
                aria-label="Search courses" placeholder="Search courses"
                className={`${FIELD} pl-9 sm:w-56`} />
            </div>
          )}
          <button onClick={addCourse} className={BTN_SECONDARY}>
            <Plus className="h-4 w-4" aria-hidden />Add Course
          </button>
        </div>
      </div>

      {courses.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="text-sm font-semibold text-slate-700">No coursework yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Upload a transcript to extract everything automatically, or add courses one at a time.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {canUpload && (
              <button onClick={onAddTranscript} disabled={!!uploadBusy} title={uploadBusy ?? undefined}
                className={BTN_PRIMARY}>{uploadBusy ? 'Analyzing…' : 'Upload transcript'}</button>
            )}
            <button onClick={addCourse} className={BTN_SECONDARY}>
              <Plus className="h-4 w-4" aria-hidden />Add Course
            </button>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="text-sm text-slate-500">No course matches “{query}”.</p>
          <button onClick={() => setQuery('')} className={`${BTN_SECONDARY} mt-3`}>
            <X className="h-4 w-4" aria-hidden />Clear search
          </button>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-5 py-3">Course</th>
                  <th scope="col" className="px-3 py-3">Term</th>
                  <th scope="col" className="px-3 py-3">Grade</th>
                  <th scope="col" className="px-3 py-3 text-right">Credits</th>
                  <th scope="col" className="px-3 py-3">Categories</th>
                  <th scope="col" className="px-5 py-3 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(course => editingId === course.id ? (
                  <tr key={course.id} className="border-b border-slate-100 bg-violet-50/40">
                    <td colSpan={6} className="px-5 py-4">
                      <CourseEditor course={course} institutions={institutions}
                        updateCourse={updateCourse} toggleCategory={toggleCategory}
                        allCourses={courses} chooseTransferLink={chooseTransferLink}
                        isNew={course.id === newCourseId}
                        onSave={finishEdit} onCancel={() => cancelEdit(course)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={course.id} className="border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70">
                    <td className="px-5 py-3.5">
                      <p className={`text-sm font-semibold ${course.name ? 'text-slate-900' : 'italic text-slate-300'}`}>
                        {course.name || 'Untitled course'}
                      </p>
                      {course.courseCode && (
                        <p className="mt-0.5 text-xs text-slate-400">{course.courseCode}</p>
                      )}
                    </td>
                    <td className="px-3 py-3.5 text-sm text-slate-600">
                      {course.term || course.year
                        ? `${course.term ?? ''}${course.term && course.year ? ' ' : ''}${course.year ?? ''}`
                        : <span className="italic text-slate-300">Not set</span>}
                    </td>
                    <td className="px-3 py-3.5">
                      <span className="inline-flex min-w-[2.25rem] justify-center rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-800">
                        {course.grade || '—'}
                      </span>
                      {notInScaleIds.has(course.id) && <div><NotInScale /></div>}
                    </td>
                    <td className="px-3 py-3.5 text-right text-sm tabular-nums text-slate-700">{course.credits}</td>
                    <td className="px-3 py-3.5"><Pills course={course} /></td>
                    <td className="px-5 py-3.5">
                      {/* D59: Edit is a visible action. The menu keeps the
                          secondary ones, but nobody has to open it to type. */}
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditingId(course.id)}
                          aria-label={`Edit ${course.name || 'this course'}`}
                          className={`${BTN_SECONDARY} !px-2.5 !py-1.5 !text-xs`}>
                          <Pencil className="h-3.5 w-3.5 text-slate-400" aria-hidden />Edit
                        </button>
                        <RowMenu label={course.name || 'this course'}
                          onEdit={() => setEditingId(course.id)}
                          onDelete={() => removeCourse(course.id)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / tablet cards */}
          <div className="divide-y divide-slate-100 lg:hidden">
            {shown.map(course => (
              <div key={course.id} className="p-4">
                {editingId === course.id ? (
                  <CourseEditor course={course} institutions={institutions}
                    updateCourse={updateCourse} toggleCategory={toggleCategory}
                    allCourses={courses} chooseTransferLink={chooseTransferLink}
                    isNew={course.id === newCourseId}
                    onSave={finishEdit} onCancel={() => cancelEdit(course)} />
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${course.name ? 'text-slate-900' : 'italic text-slate-300'}`}>
                          {course.name || 'Untitled course'}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {[course.courseCode, [course.term, course.year].filter(Boolean).join(' ')]
                            .filter(Boolean).join(' · ') || 'No term set'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button onClick={() => setEditingId(course.id)}
                          aria-label={`Edit ${course.name || 'this course'}`}
                          className={`${BTN_SECONDARY} !px-2.5 !py-1.5 !text-xs`}>
                          <Pencil className="h-3.5 w-3.5 text-slate-400" aria-hidden />Edit
                        </button>
                        <RowMenu label={course.name || 'this course'}
                          onEdit={() => setEditingId(course.id)}
                          onDelete={() => removeCourse(course.id)} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-800">
                        {course.grade || '—'}
                      </span>
                      <span className="text-sm text-slate-500">
                        {course.credits} credit{course.credits === 1 ? '' : 's'}
                      </span>
                      <Pills course={course} />
                    </div>
                    {notInScaleIds.has(course.id) && <NotInScale />}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
