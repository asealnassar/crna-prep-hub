'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatAgo, formatDate, formatNumber } from '@/lib/analytics/format'
import type { UserActivityResult, UserActivityRow } from '@/lib/analytics/server/userActivity'
import { Card, EmptyState, Skeleton } from './primitives'

/**
 * Every member, searchable.
 *
 * The search, the sort and the paging all happen on the server: the browser
 * asks for 25 rows and receives 25 rows. The page this replaces downloaded
 * every account and every question row to build the same table, and then got
 * the columns wrong because its question read stopped at 1000 rows.
 *
 * Interviews here are authorised interviews, not question rows.
 */

const TIER_FILTERS = ['all', 'free', 'premium', 'ultimate'] as const

const SORTS: readonly { id: string; label: string }[] = [
  { id: 'recent', label: 'Last active' },
  { id: 'signup', label: 'Newest' },
  { id: 'interviews', label: 'Most interviews' },
  { id: 'actions', label: 'Most active' },
  { id: 'email', label: 'Email A–Z' },
]

export function MemberTable({ timezone }: { timezone: string }) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [tier, setTier] = useState<string>('all')
  const [sort, setSort] = useState('recent')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UserActivityResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, tier, sort])

  useEffect(() => {
    const ticket = ++request.current
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({ sort, page: String(page), pageSize: '25' })
    if (debounced) params.set('search', debounced)
    if (tier !== 'all') params.set('tier', tier)

    fetch(`/api/admin/analytics/users?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The member list could not be loaded (${response.status}).`)
        return (await response.json()) as UserActivityResult
      })
      .then((result) => {
        if (request.current === ticket) setData(result)
      })
      .catch((problem: Error) => {
        if (request.current === ticket) setError(problem.message)
      })
      .finally(() => {
        if (request.current === ticket) setLoading(false)
      })
  }, [debounced, tier, sort, page])

  const pages = useMemo(() => (data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1), [data])

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold text-slate-900">
          Members{data ? ` · ${formatNumber(data.total)}` : ''}
        </h3>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by email"
          className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm sm:w-56"
          aria-label="Search members by email"
        />
        <select
          value={tier}
          onChange={(event) => setTier(event.target.value)}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
          aria-label="Filter by tier"
        >
          {TIER_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? 'All tiers' : value[0].toUpperCase() + value.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value)}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
          aria-label="Sort members"
        >
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {loading && !data ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : data && data.rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="No member matches that search." />
        </div>
      ) : (
        data && (
          <>
            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-medium">Member</th>
                    <th className="pb-2 font-medium">Tier</th>
                    <th className="pb-2 text-right font-medium">Interviews</th>
                    <th className="pb-2 text-right font-medium">Actions</th>
                    <th className="pb-2 font-medium">Last active</th>
                    <th className="pb-2 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((row) => (
                    <tr key={row.userId} className="hover:bg-slate-50/70">
                      <td className="py-2.5 pr-3">
                        <p className="truncate text-slate-800" title={row.email ?? ''}>
                          {row.email ?? '(no email)'}
                        </p>
                        {!row.emailConfirmed && <p className="text-[11px] text-amber-600">Email unconfirmed</p>}
                      </td>
                      <td className="py-2.5 pr-3">
                        <TierChip tier={row.tier} />
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-800">
                        {formatNumber(row.interviewsStarted)}
                        <span className="text-xs text-slate-400"> / {formatNumber(row.interviewsCompleted)} done</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-800">{formatNumber(row.actions)}</td>
                      <td className="py-2.5 pr-3 text-slate-600" title={row.lastActiveAt ?? ''}>
                        {formatAgo(row.lastActiveAt)}
                      </td>
                      <td className="py-2.5 text-slate-600">{formatDate(row.signedUpAt, timezone)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="mt-4 space-y-2 md:hidden">
              {data.rows.map((row) => (
                <MemberCard key={row.userId} row={row} timezone={timezone} />
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-600">
              <span>
                Page {data.page} of {pages}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={data.page <= 1 || loading}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 font-medium transition hover:bg-slate-50 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={data.page >= pages || loading}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 font-medium transition hover:bg-slate-50 disabled:opacity-40"
                >
                  Next
                </button>
              </span>
            </div>
          </>
        )
      )}

      <p className="mt-3 text-[11px] text-slate-400">
        Interviews are authorised interviews, one per mock. Actions count rows a member wrote across the product, so
        reading the site without doing anything leaves no trace here.
      </p>
    </Card>
  )
}

function MemberCard({ row, timezone }: { row: UserActivityRow; timezone: string }) {
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm text-slate-800">{row.email ?? '(no email)'}</p>
        <TierChip tier={row.tier} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
        <div className="flex justify-between">
          <dt>Interviews</dt>
          <dd className="font-medium text-slate-800">
            {formatNumber(row.interviewsStarted)} / {formatNumber(row.interviewsCompleted)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Actions</dt>
          <dd className="font-medium text-slate-800">{formatNumber(row.actions)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Last active</dt>
          <dd>{formatAgo(row.lastActiveAt)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Joined</dt>
          <dd>{formatDate(row.signedUpAt, timezone)}</dd>
        </div>
      </dl>
    </li>
  )
}

function TierChip({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    ultimate: 'bg-violet-50 text-violet-700 ring-violet-200',
    premium: 'bg-blue-50 text-blue-700 ring-blue-200',
    free: 'bg-slate-100 text-slate-600 ring-slate-200',
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        styles[tier] ?? 'bg-amber-50 text-amber-700 ring-amber-200'
      }`}
    >
      {tier}
    </span>
  )
}
