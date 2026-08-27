'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function AdminSchoolUnlocks() {
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'pending' | 'approved' | 'all'>('pending')
  const supabase = createClient()

  useEffect(() => {
    fetchRequests()
  }, [])

  const fetchRequests = async () => {
    const { data } = await supabase
      .from('school_unlock_requests')
      .select('*')
      .order('requested_at', { ascending: false })

    setRequests(data || [])
    setLoading(false)
  }

  const approveRequest = async (id: string) => {
    await supabase
      .from('school_unlock_requests')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id)

    setRequests(requests.map(r => r.id === id ? { ...r, status: 'approved', approved_at: new Date().toISOString() } : r))

    const req = requests.find(r => r.id === id)
    if (req) {
      fetch('/api/school-unlock/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientEmail: req.user_email, schoolName: req.school_name })
      }).catch(err => console.error('Unlock email failed:', err))
    }
  }

  const denyRequest = async (id: string) => {
    if (!confirm('Delete this request? The user will be able to request again.')) return
    await supabase
      .from('school_unlock_requests')
      .delete()
      .eq('id', id)

    setRequests(requests.filter(r => r.id !== id))
  }

  const filteredRequests = requests.filter(r => {
    if (filter === 'all') return true
    return r.status === filter
  })

  const pendingCount = requests.filter(r => r.status === 'pending').length

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">School Unlock Requests</h1>
            <p className="text-gray-500 text-sm mt-1">{pendingCount} pending request{pendingCount !== 1 ? 's' : ''}</p>
          </div>
          <Link href="/admin" className="text-purple-600 hover:underline text-sm">← Back to Admin</Link>
        </div>

        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setFilter('pending')}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${filter === 'pending' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}
          >
            Pending ({pendingCount})
          </button>
          <button
            onClick={() => setFilter('approved')}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${filter === 'approved' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}
          >
            Approved
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${filter === 'all' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}
          >
            All
          </button>
        </div>

        {filteredRequests.length === 0 ? (
          <div className="bg-white rounded-xl p-8 text-center text-gray-500">
            No {filter !== 'all' ? filter : ''} requests
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRequests.map((req) => (
              <div key={req.id} className="bg-white rounded-xl p-4 sm:p-5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-gray-800">{req.school_name}</h3>
                    {req.status === 'approved' ? (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">✅ Approved</span>
                    ) : (
                      <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-semibold rounded-full">⏳ Pending</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{req.user_email}</p>
                  <p className="text-xs text-gray-400 mt-0.5">Requested {new Date(req.requested_at).toLocaleDateString()} at {new Date(req.requested_at).toLocaleTimeString()}</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {req.status !== 'approved' && (
                    <button
                      onClick={() => approveRequest(req.id)}
                      className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 transition"
                    >
                      ✅ Approve
                    </button>
                  )}
                  <button
                    onClick={() => denyRequest(req.id)}
                    className="px-4 py-2 bg-red-100 text-red-700 text-sm font-semibold rounded-lg hover:bg-red-200 transition"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
