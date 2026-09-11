'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { CONTACT_FIELDS } from '@/lib/resume/studio/patch'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import type { ContactField } from '@/lib/resume/studio/patch'

/**
 * The guided start.
 *
 * THE ROW EXISTS BEFORE THE FIRST KEYSTROKE. Opening this page creates the
 * draft, and every field below is saved against it. That is the blueprint's
 * "a draft is a real row from the first keystroke" -- there is no client-only
 * state here that a closed tab could lose, and no moment where an applicant has
 * typed their details into something that does not exist yet.
 *
 * It collects only what nothing else can infer: who they are. Everything else
 * is the Studio's job, and this hands off to it rather than growing into a
 * second editor.
 */

const ENDPOINT = '/api/resume-v2/draft'

const STEPS: readonly { field: ContactField; label: string; hint: string }[] = [
  { field: 'fullName', label: 'Your name', hint: 'As it should appear at the top of the resume.' },
  { field: 'credentials', label: 'Credentials', hint: 'BSN, RN, CCRN — in the order you use them.' },
  { field: 'email', label: 'Email', hint: 'The address a programme should reply to.' },
  { field: 'phone', label: 'Phone', hint: 'Optional, but most applicants include one.' },
  { field: 'city', label: 'City', hint: '' },
  { field: 'state', label: 'State', hint: '' },
]

export default function OnboardFlow() {
  const router = useRouter()
  const { sidebarCollapsed } = useSidebarCollapsed()

  const [resumeId, setResumeId] = useState<string | null>(null)
  const [revision, setRevision] = useState(1)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const created = useRef(false)

  useEffect(() => {
    // Strict mode mounts effects twice in development; without this guard the
    // applicant would be given two drafts before typing anything.
    if (created.current) return
    created.current = true

    void (async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create' }),
        })
        if (!res.ok) {
          setError('Could not start a new resume.')
          return
        }
        const body = await res.json()
        setResumeId(String(body.id))
        setRevision(Number(body.revision) || 1)
      } catch {
        setError('Could not reach the server.')
      }
    })()
  }, [])

  const save = useCallback(async () => {
    if (!resumeId) return
    const patches: StudioPatch[] = CONTACT_FIELDS.filter((f) => values[f] !== undefined).map((field) => ({
      op: 'contact', field, value: values[field] ?? '',
    }))
    if (patches.length === 0) {
      router.push(`/resume-studio/${resumeId}`)
      return
    }

    setSaving(true)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'patch', id: resumeId, expectedRevision: revision, patches }),
      })
      if (!res.ok) {
        setError('Could not save your details. They are still here — try again.')
        return
      }
      router.push(`/resume-studio/${resumeId}`)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setSaving(false)
    }
  }, [resumeId, revision, values, router])

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <h1 className="text-3xl font-bold text-white mb-2">Let’s start your resume</h1>
          <p className="text-indigo-200 mb-6">
            Just the header for now. Everything else you’ll build in the Studio.
          </p>

          {error && (
            <div role="alert" className="mb-6 bg-amber-400/15 border border-amber-300/40 text-amber-100 rounded-xl px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); void save() }}
          >
            {STEPS.map((step) => (
              <div key={step.field}>
                <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`onboard-${step.field}`}>
                  {step.label}
                </label>
                <input
                  id={`onboard-${step.field}`}
                  className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  value={values[step.field] ?? ''}
                  aria-describedby={step.hint ? `hint-${step.field}` : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [step.field]: e.target.value }))}
                />
                {step.hint && (
                  <p id={`hint-${step.field}`} className="mt-1 text-xs text-indigo-300">{step.hint}</p>
                )}
              </div>
            ))}

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="submit"
                disabled={!resumeId || saving}
                className="px-5 py-2.5 bg-white text-indigo-900 font-semibold rounded-xl hover:bg-indigo-50 transition disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Open the Studio'}
              </button>
              <button
                type="button"
                disabled={!resumeId}
                onClick={() => resumeId && router.push(`/resume-studio/${resumeId}`)}
                className="px-5 py-2.5 border border-white/30 text-white font-semibold rounded-xl hover:bg-white/10 transition disabled:opacity-60"
              >
                Skip for now
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
