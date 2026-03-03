'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function Analytics() {
  const [users, setUsers] = useState<any[]>([])
  const [feedback, setFeedback] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState<'users' | 'feedback'>('users')
  const router = useRouter()
  const supabase = createClient()

  const loadData = async () => {
    const response = await fetch('/api/admin/users')
    const authUsers = await response.json()
    
    console.log('Auth users:', authUsers)
    
    const { data: profiles } = await supabase.from('user_profiles').select('*')
    console.log('Profiles:', profiles)

    const { data: questions } = await supabase
      .from('user_asked_questions')
      .select('*')
      .order('asked_at', { ascending: false })

    console.log('Questions:', questions)

    // Combine data with debug logging
    const combinedUsers = authUsers?.map((authUser: any) => {
      const profile = profiles?.find(p => p.id === authUser.id)
      const userQuestions = questions?.filter(q => q.user_id === authUser.id) || []
      const interviewTypes = [...new Set(userQuestions.map(q => q.interview_type))]
      const lastInterview = userQuestions.length > 0 ? userQuestions[0]?.asked_at : null

      // Debug specific user
      if (authUser.email === 'anassar@icpcnj.org') {
        console.log('DEBUG anassar@icpcnj.org:')
        console.log('  authUser.id:', authUser.id)
        console.log('  profile found:', !!profile)
        console.log('  userQuestions count:', userQuestions.length)
        console.log('  sample question user_ids:', questions?.slice(0, 5).map(q => q.user_id))
      }

      return {
        id: authUser.id,
        email: authUser.email,
        subscription_tier: profile?.subscription_tier || 'free',
        interview_count: userQuestions.length,
        created_at: authUser.created_at,
        totalQuestions: userQuestions.length,
        interviewTypes,
        lastInterview
      }
    }).sort((a: any, b: any) => b.totalQuestions - a.totalQuestions) || []

    console.log('Combined users:', combinedUsers)
    setUsers(combinedUsers)

    const { data: feedbackData } = await supabase
      .from('interview_feedback')
      .select('*')
      .order('created_at', { ascending: false})

    setFeedback(feedbackData || [])
  }

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user || user.email !== 'asealnassar@gmail.com') {
        router.push('/dashboard')
        return
      }

      setUserEmail(user.email)
      setIsAdmin(true)

      await loadData()
      setLoading(false)
    }

    init()
  }, [])

  const deleteFeedback = async (id: string) => {
    if (!confirm('Delete this feedback?')) return
    await supabase.from('interview_feedback').delete().eq('id', id)
    setFeedback(feedback.filter(f => f.id !== id))
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  const activeUsers = users.filter(u => u.totalQuestions > 0)
  const ultimateUsers = users.filter(u => u.subscription_tier === 'ultimate')
  const premiumUsers = users.filter(u => u.subscription_tier === 'premium')
  const totalQuestions = users.reduce((sum, u) => sum + u.totalQuestions, 0)

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar 
        isLoggedIn={true} 
        userEmail={userEmail} 
        isAdmin={isAdmin}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'ml-20' : 'ml-64'}`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-6 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-white">📊 Analytics Dashboard</h1>
          <Link href="/admin/schools" className="text-white/80 hover:text-white text-sm">
            ← Back to Admin
          </Link>
        </div>

        <div className="max-w-7xl mx-auto px-8 py-12">
          
          <div className="grid md:grid-cols-4 gap-6 mb-8">
            <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-6">
              <div className="text-3xl mb-2">👥</div>
              <h3 className="text-3xl font-bold text-white">{users.length}</h3>
              <p className="text-indigo-200">Total Users</p>
            </div>

            <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-6">
              <div className="text-3xl mb-2">🎤</div>
              <h3 className="text-3xl font-bold text-white">{activeUsers.length}</h3>
              <p className="text-indigo-200">Used Interview</p>
            </div>

            <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-6">
              <div className="text-3xl mb-2">⭐</div>
              <h3 className="text-3xl font-bold text-white">{ultimateUsers.length}</h3>
              <p className="text-indigo-200">Ultimate Members</p>
            </div>

            <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-6">
              <div className="text-3xl mb-2">💬</div>
              <h3 className="text-3xl font-bold text-white">{totalQuestions}</h3>
              <p className="text-indigo-200">Questions Asked</p>
            </div>
          </div>

          <div className="flex gap-4 mb-8">
            <button
              onClick={() => setActiveTab('users')}
              className={`px-6 py-3 rounded-xl font-semibold transition ${
                activeTab === 'users'
                  ? 'bg-white text-purple-600'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              User Activity ({users.length})
            </button>
            <button
              onClick={() => setActiveTab('feedback')}
              className={`px-6 py-3 rounded-xl font-semibold transition ${
                activeTab === 'feedback'
                  ? 'bg-white text-purple-600'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              Feedback ({feedback.length})
            </button>
          </div>

          {activeTab === 'users' && (
            <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gradient-to-r from-purple-600 to-pink-500 text-white">
                    <tr>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Email</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Tier</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Questions Asked</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Types Used</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Last Interview</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Signed Up</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {users.map((user, index) => (
                      <tr key={user.id} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-6 py-4 text-sm text-gray-800">{user.email}</td>
                        <td className="px-6 py-4">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                            user.subscription_tier === 'ultimate' ? 'bg-purple-100 text-purple-700' :
                            user.subscription_tier === 'premium' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {user.subscription_tier?.toUpperCase() || 'FREE'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-800 font-semibold">{user.totalQuestions}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {user.interviewTypes.length > 0 ? user.interviewTypes.join(', ') : '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {user.lastInterview ? new Date(user.lastInterview).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'feedback' && (
            <div className="space-y-4">
              {feedback.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 text-center">
                  <p className="text-gray-500">No feedback yet</p>
                </div>
              ) : (
                feedback.map((item) => (
                  <div key={item.id} className="bg-white rounded-2xl p-6 shadow-lg relative">
                    <button
                      onClick={() => deleteFeedback(item.id)}
                      className="absolute top-4 right-4 px-3 py-1 bg-red-100 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-200 transition"
                    >
                      Delete
                    </button>
                    <div className="flex justify-between items-start mb-4 pr-20">
                      <div>
                        <p className="font-semibold text-gray-800">{item.user_email}</p>
                        <p className="text-sm text-gray-500">{new Date(item.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <p className="text-gray-700 whitespace-pre-wrap">{item.message}</p>
                  </div>
                ))
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
