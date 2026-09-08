import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
/** Source with its prose stripped, so a comment can never satisfy a test. */
const code = (p: string) =>
  read(p).replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '')

const PANEL = () => code('app/gpa-calculator/components/CoursesPanel.tsx')
const PAGE = () => code('app/gpa-calculator/page.tsx')

// ------------------------------------------------- adding opens the editor
test('D59: Add Course opens the new course directly in edit mode', () => {
  const page = PAGE()
  const add = page.slice(page.indexOf('const addCourse ='), page.indexOf('const replaceCourse ='))
  assert.match(add, /setEditingId\(id\)/, 'the new row is the one being edited')
  assert.match(add, /setNewCourseId\(id\)/, 'and it is remembered as new')
  assert.match(add, /setActiveTab\('courses'\)/, 'on the tab where it appears')
  // The id is made first so it can be both stored and opened.
  assert.ok(add.indexOf('const id =') < add.indexOf('setEditingId(id)'))
})

test('D59: the editor renders wherever the row is, not behind a menu', () => {
  const panel = PANEL()
  // Both layouts swap the row for the editor when it is the one being edited.
  assert.equal(panel.split('editingId === course.id').length - 1, 2,
    'the table row and the mobile card both do it')
  assert.equal(panel.split('<CourseEditor').length - 1, 2)
})

test('D59: every field the approved list names is in the editor', () => {
  const panel = PANEL()
  const editor = panel.slice(panel.indexOf('function CourseEditor'), panel.indexOf('export function CoursesPanel'))
  for (const label of ['Course name', 'Course code', 'School', 'Term', 'Year',
                       'Grade', 'Credits', 'Academic level', 'Categories and handling']) {
    assert.ok(editor.includes(label), label)
  }
  // Transfer status stays where it already was.
  assert.match(editor, /Transferred in/)
  assert.match(editor, /toggleCategory\(course\.id, 'science'\)/)
  assert.match(editor, /toggleCategory\(course\.id, 'nursing'\)/)
})

// ------------------------------------------------------------ save / cancel
test('D59: the editor offers Save course and Cancel', () => {
  const panel = PANEL()
  assert.match(panel, /onClick=\{onSave\}[\s\S]{0,80}Save course/)
  assert.match(panel, /onClick=\{onCancel\}[\s\S]{0,60}Cancel/)
  assert.ok(!/>Done</.test(panel), 'the ambiguous single button is gone')
})

test('D59: Save simply closes the editor, so it cannot duplicate anything', () => {
  const panel = PANEL()
  const finish = panel.slice(panel.indexOf('const finishEdit ='), panel.indexOf('const cancelEdit ='))
  assert.match(finish, /setEditingId\(null\)/)
  assert.match(finish, /clearNewCourse\?\.\(\)/)
  // Saving never appends: the row already exists from the moment it was added.
  assert.ok(!/setCourses|addCourse\(|push\(/.test(finish))
})

test('D59: Cancel on a brand-new course removes the row', () => {
  const panel = PANEL()
  const cancel = panel.slice(panel.indexOf('const cancelEdit ='), panel.indexOf('const [query'))
  assert.match(cancel, /if \(newCourseId && course\.id === newCourseId\)/)
  assert.match(cancel, /removeCourse\(course\.id\)/)
})

test('D59: Cancel on an existing course restores what it was', () => {
  const panel = PANEL()
  const cancel = panel.slice(panel.indexOf('const cancelEdit ='), panel.indexOf('const [query'))
  assert.match(cancel, /replaceCourse\?\.\(course\.id, snapshot\)/)
  // The snapshot is taken when the edited course changes, never per keystroke.
  assert.match(panel, /setSnapshot\(prev => \(prev && prev\.id === editingId \? prev : current \?\? null\)\)/)
  assert.match(panel, /\}, \[editingId\]\)/)

  const page = PAGE()
  assert.match(page, /const replaceCourse = \(id: string, course: Course\) =>/)
  assert.match(page, /prev\.map\(c => \(c\.id === id \? course : c\)\)/, 'one row swapped, nothing else')
})

// --------------------------------------------------------- the row actions
test('D59: each row carries a visible Edit action', () => {
  const panel = PANEL()
  const edits = panel.match(/aria-label=\{`Edit \$\{course\.name/g) ?? []
  assert.equal(edits.length, 2, 'the table row and the mobile card')
  // A real button on each layout, sitting beside the row's menu rather than
  // inside it -- the menu's own Edit item is a <button role="menuitem">.
  const rowButtons = panel.match(/<button onClick=\{\(\) => setEditingId\(course\.id\)\}/g) ?? []
  assert.equal(rowButtons.length, 2)
  assert.equal(panel.match(/role="menuitem"/g)?.length, 2, 'the menu keeps its own items')
})

test('D59: the secondary menu survives, with Delete still in it', () => {
  const panel = PANEL()
  assert.equal(panel.split('<RowMenu label=').length - 1, 2, 'still on both layouts')
  const menu = panel.slice(panel.indexOf('function RowMenu'), panel.indexOf('function CourseEditor'))
  assert.match(menu, /role="menuitem"[\s\S]{0,200}Delete/)
  assert.match(menu, /aria-haspopup="menu"/)
  assert.match(menu, /aria-expanded=\{open\}/)
})

// ------------------------------------------------------------- validation
test('D59: missing information is guidance, never a refused save', () => {
  const panel = PANEL()
  assert.match(panel, /if \(!course\.name\.trim\(\)\) missing\.push\('a course name'\)/)
  assert.match(panel, /if \(!course\.institutionId\) missing\.push\('a school'\)/)
  assert.match(panel, /missing\.push\('credits above zero'\)/)
  assert.match(panel, /Add \{missing\.join\(', '\)\} for this course to count toward your GPA/)
  // Save is never disabled and nothing is blocked -- the engine already reports
  // what it cannot count, and no new academic rule is introduced here.
  assert.ok(!/disabled=\{[^}]*missing/.test(panel))
})

// ------------------------------------------------------------------ mobile
test('D59: the editor stacks on a narrow screen', () => {
  const panel = PANEL()
  const editor = panel.slice(panel.indexOf('function CourseEditor'), panel.indexOf('export function CoursesPanel'))
  // Every grid is one column until sm/lg, so nothing sits side by side on a phone.
  for (const grid of editor.match(/className="grid gap-3[^"]*"/g) ?? []) {
    assert.match(grid, /grid gap-3 (sm|lg):grid-cols/, grid)
  }
  assert.match(panel, /flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end/,
    'Save and Cancel stack, with Save on top on a phone')
  assert.match(panel, /!py-2\.5/, 'and stay comfortably tappable')
})

// ------------------------------------------------------- user authority
test('D59: a manual category edit is still the user’s to keep', () => {
  const page = PAGE()
  const update = page.slice(page.indexOf('const toggleCategory ='), page.indexOf('const toggleCategory =') + 700)
  assert.match(update, /categorySource: 'user'/, 'a hand-picked category is marked as the user’s')

  // And the deterministic pass returns such a course untouched.
  const classification = read('lib/gpa/classification.ts')
  assert.match(classification, /if \(course\.categorySource === 'user'\) return course/)
})

test('D59: editing a field does not re-run the transcript pipeline', () => {
  const page = PAGE()
  const update = page.slice(page.indexOf('const updateCourse ='), page.indexOf('const updateCourse =') + 900)
  assert.ok(!/applyCategoryClassification|applyTransferSections|analyze-transcript/.test(update),
    'a manual edit is a manual edit')
})
