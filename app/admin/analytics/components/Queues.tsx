'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { feedbackSourceLabel, feedbackSourceOf, feedbackTypeOf } from '@/lib/resume/feedback/submission'
import { formatDateTime } from '@/lib/analytics/format'
import { Card, EmptyState, Skeleton } from './primitives'

/**
 * Feedback, feature requests and school unlock requests.
 *
 * THE BEHAVIOUR HERE IS THE OLD PAGE'S, UNCHANGED. The same three reads, the
 * same delete and approve actions, the same confirmation prompts, and the same
 * call to the unlock notification endpoint after an approval. Only the
 * presentation is new: these queues are worked with every day and this release
 * is not the place to change how they behave.
 */

type Feedback = { id: string; user_email: string | null; message: string | null; created_at: string }
type FeatureRequest = {
  id: string
  user_email: string | null
  idea: string | null
  status: string | null
  created_at: string
}
type UnlockRequest = {
  id: string
  user_email: string | null
  school_name: string | null
  status: string | null
  requested_at: string
}

type QueueTab = 'feedback' | 'features' | 'unlocks'

export function Queues({ timezone }: { timezone: string }) {
  const supabase = createClient()
  const [tab, setTab] = useState<QueueTab>('feedback')
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [features, setFeatures] = useState<FeatureRequest[]>([])
  const [unlocks, setUnlocks] = useState<UnlockRequest[]>([])
  const [feedbackSource, setFeedbackSource] = useState<'all' | 'v1' | 'v2'>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const [feedbackResult, featureResult, unlockResult] = await Promise.all([
        supabase.from('interview_feedback').select('*').order('created_at', { ascending: false }),
        supabase.from('feature_requests').select('*').order('created_at', { ascending: false }),
        supabase.from('school_unlock_requests').select('*').order('requested_at', { ascending: false }),
      ])
      setFeedback((feedbackResult.data as Feedback[]) || [])
      setFeatures((featureResult.data as FeatureRequest[]) || [])
      setUnlocks((unlockResult.data as UnlockRequest[]) || [])
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deleteFeedback = async (id: string) => {
    if (!confirm('Delete this feedback?')) return
    await supabase.from('interview_feedback').delete().eq('id', id)
    setFeedback((current) => current.filter((item) => item.id !== id))
  }

  const deleteFeatureRequest = async (id: string) => {
    if (!confirm('Delete this feature request?')) return
    await supabase.from('feature_requests').delete().eq('id', id)
    setFeatures((current) => current.filter((item) => item.id !== id))
  }

  const approveUnlockRequest = async (id: string) => {
    const approvedAt = new Date().toISOString()
    await supabase
      .from('school_unlock_requests')
      .update({ status: 'approved', approved_at: approvedAt })
      .eq('id', id)
    setUnlocks((current) =>
      current.map((item) => (item.id === id ? { ...item, status: 'approved' } : item))
    )

    const request = unlocks.find((item) => item.id === id)
    if (request) {
      fetch('/api/school-unlock/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientEmail: request.user_email, schoolName: request.school_name }),
      }).catch((error) => console.error('Unlock email failed:', error))
    }
  }

  const deleteUnlockRequest = async (id: string) => {
    if (!confirm('Delete this unlock request?')) return
    await supabase.from('school_unlock_requests').delete().eq('id', id)
    setUnlocks((current) => current.filter((item) => item.id !== id))
  }

  const visibleFeedback = feedbackSource === 'all'
    ? feedback
    : feedback.filter((item) => feedbackSourceOf(item.message) === feedbackSource)
  const pendingUnlocks = unlocks.filter((item) => item.status !== 'approved')

  const tabs: { id: QueueTab; label: string; count: number }[] = [
    { id: 'feedback', label: 'Feedback', count: feedback.length },
    { id: 'features', label: 'Feature requests', count: features.length },
    { id: 'unlocks', label: 'School requests', count: pendingUnlocks.length },
  ]

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              tab === item.id ? 'bg-violet-50 text-violet-700' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {item.label}
            {/* One count per tab. Showing the quiet number AND the red badge
                rendered "School requests 6 6" whenever anything was pending. */}
            {item.id === 'unlocks' && item.count > 0 ? (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                {item.count}
              </span>
            ) : (
              <span className="ml-1.5 text-xs text-slate-400">{item.count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <div className="mt-4">
          {tab === 'feedback' && (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(
                  [
                    ['all', 'All'],
                    ['v2', 'Resume Builder V2'],
                    ['v1', 'Resume Builder V1'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFeedbackSource(key)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                      feedbackSource === key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {label} ({key === 'all' ? feedback.length : feedback.filter((item) => feedbackSourceOf(item.message) === key).length})
                  </button>
                ))}
              </div>

              {visibleFeedback.length === 0 ? (
                <EmptyState title="No feedback yet." />
              ) : (
                <ul className="space-y-2">
                  {visibleFeedback.map((item) => {
                    const source = feedbackSourceOf(item.message)
                    const type = feedbackTypeOf(item.message)
                    return (
                      <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">{item.user_email}</p>
                            <p className="text-[11px] text-slate-500">{formatDateTime(item.created_at, timezone)}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteFeedback(item.id)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                        {source && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                              {feedbackSourceLabel(source)}
                            </span>
                            {type && (
                              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                                {type}
                              </span>
                            )}
                          </div>
                        )}
                        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{item.message}</p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}

          {tab === 'features' && (
            features.length === 0 ? (
              <EmptyState title="No feature requests yet." />
            ) : (
              <ul className="space-y-2">
                {features.map((item) => (
                  <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{item.user_email}</p>
                        <p className="text-[11px] text-slate-500">{formatDateTime(item.created_at, timezone)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            item.status === 'approved'
                              ? 'bg-emerald-50 text-emerald-700'
                              : item.status === 'reviewing'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {(item.status || 'pending').toUpperCase()}
                        </span>
                        <button
                          type="button"
                          onClick={() => deleteFeatureRequest(item.id)}
                          className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-sm text-slate-700">
                      {item.idea}
                    </p>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'unlocks' && (
            unlocks.length === 0 ? (
              <EmptyState title="No school unlock requests yet." />
            ) : (
              <ul className="space-y-2">
                {unlocks.map((item) => (
                  <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-slate-800">{item.school_name}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              item.status === 'approved'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {item.status === 'approved' ? 'Approved' : 'Pending'}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-600">{item.user_email}</p>
                        <p className="text-[11px] text-slate-500">
                          Requested {formatDateTime(item.requested_at, timezone)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.status !== 'approved' && (
                          <button
                            type="button"
                            onClick={() => approveUnlockRequest(item.id)}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                          >
                            Approve
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => deleteUnlockRequest(item.id)}
                          className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </Card>
  )
}
