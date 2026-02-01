'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function AdminReports() {
  const [reports, setReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchReports = async () => {
      const { data } = await supabase
        .from('school_reports')
        .select('*')
        .order('created_at', { ascending: false })
      
      setReports(data || [])
      setLoading(false)
    }
    fetchReports()
  }, [])

  const markResolved = async (id: string) => {
    await supabase
      .from('school_reports')
      .update({ status: 'resolved' })
      .eq('id', id)
    
    setReports(reports.map(r => r.id === id ? { ...r, status: 'resolved' } : r))
  }

  const deleteReport = async (id: string) => {
    await supabase
      .from('school_reports')
      .delete()
      .eq('id', id)
    
    setReports(reports.filter(r => r.id !== id))
  }

  if (loading) {
    return <div className="min-h-screen bg-gray-100 flex items-center justify-center">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold text-purple-600">Admin - Error Reports</h1>
            <div className="flex gap-4">
              <Link href="/admin" className="text-gray-600 hover:text-purple-600">Dashboard</Link>
              <Link href="/schools" className="text-gray-600 hover:text-purple-600">Schools</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-gray-800">
            {reports.filter(r => r.status === 'pending').length} Pending Reports
          </h2>
        </div>

        {reports.length === 0 ? (
          <div className="bg-white rounded-xl p-8 text-center text-gray-500">
            No error reports yet! 🎉
          </div>
        ) : (
          <div className="space-y-4">
            {reports.map((report) => (
              <div 
                key={report.id} 
                className={`bg-white rounded-xl shadow p-6 ${report.status === 'resolved' ? 'opacity-60' : ''}`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-lg text-gray-800">{report.school_name}</h3>
                    <p className="text-sm text-gray-500">
                      Field: <span className="font-medium">{report.field_with_error || 'Not specified'}</span>
                    </p>
                    <p className="text-sm text-gray-500">
                      Reported by: {report.reporter_email}
                    </p>
                    <p className="text-sm text-gray-500">
                      {new Date(report.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    report.status === 'pending' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'
                  }`}>
                    {report.status}
                  </span>
                </div>
                
                <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                  <p className="text-gray-700">{report.description}</p>
                </div>

                <div className="mt-4 flex gap-3">
                  {report.status === 'pending' && (
                    <button
                      onClick={() => markResolved(report.id)}
                      className="px-4 py-2 bg-green-500 text-white rounded-lg text-sm hover:bg-green-600 transition"
                    >
                      ✓ Mark Resolved
                    </button>
                  )}
                  <button
                    onClick={() => deleteReport(report.id)}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition"
                  >
                    🗑 Delete
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
