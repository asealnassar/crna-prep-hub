'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function ForumPage() {
  const [posts, setPosts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userId, setUserId] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [showNewPost, setShowNewPost] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [replyCounts, setReplyCounts] = useState<{[key: string]: number}>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'mine'>('all')
  const [newReplyPostIds, setNewReplyPostIds] = useState<Set<string>>(new Set())
  const supabase = createClient()

  const avatarColors = [
    'from-purple-500 to-indigo-600',
    'from-pink-500 to-rose-600',
    'from-blue-500 to-cyan-600',
    'from-green-500 to-emerald-600',
    'from-orange-500 to-amber-600',
    'from-red-500 to-pink-600',
  ]

  const getAvatarColor = (email: string) => {
    const index = email?.length % avatarColors.length || 0
    return avatarColors[index]
  }

  useEffect(() => {
    init()
  }, [])

  const init = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      setIsLoggedIn(true)
      setUserEmail(user.email || '')
      setUserId(user.id)
      setIsAdmin(user.email === 'asealnassar@gmail.com')
      await loadPosts(user.id)
    } else {
      await loadPosts(null)
    }
    setLoading(false)
  }

  const loadPosts = async (uid: string | null) => {
    const { data: postsData } = await supabase
      .from('forum_posts')
      .select('*')
      .order('created_at', { ascending: false })

    setPosts(postsData || [])

    if (postsData && postsData.length > 0) {
      const counts: {[key: string]: number} = {}
      for (const post of postsData) {
        const { count } = await supabase
          .from('forum_replies')
          .select('*', { count: 'exact', head: true })
          .eq('post_id', post.id)
        counts[post.id] = count || 0
      }
      setReplyCounts(counts)

      if (uid) {
        const myPosts = postsData.filter(p => p.user_id === uid)
        const newSet = new Set<string>()

        for (const post of myPosts) {
          const { data: viewData } = await supabase
            .from('forum_post_views')
            .select('last_viewed_at')
            .eq('post_id', post.id)
            .eq('user_id', uid)
            .maybeSingle()

          const { count: replyCountAfterView } = await supabase
            .from('forum_replies')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post.id)
            .neq('user_id', uid)
            .gt('created_at', viewData?.last_viewed_at || post.created_at)

          if ((replyCountAfterView || 0) > 0) {
            newSet.add(post.id)
          }
        }
        setNewReplyPostIds(newSet)
      }
    }
  }

  const createPost = async () => {
    if (!newTitle.trim() || !newContent.trim()) {
      alert('Please fill in both title and content')
      return
    }
    setSubmitting(true)
    await supabase.from('forum_posts').insert({
      user_id: userId,
      user_email: userEmail,
      title: newTitle,
      content: newContent
    })
    setNewTitle('')
    setNewContent('')
    setShowNewPost(false)
    setSubmitting(false)
    await loadPosts(userId)
  }

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const getDisplayName = (email: string) => {
    if (email === 'asealnassar@gmail.com') return 'CRNA Prep Hub Admin'
    return email?.split('@')[0] || 'Anonymous'
  }

  const getInitial = (email: string) => {
    if (email === 'asealnassar@gmail.com') return 'A'
    return email?.[0]?.toUpperCase() || '?'
  }

  const filteredPosts = posts
    .filter(post =>
      post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.content.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .filter(post => filterMode === 'all' || post.user_id === userId)

  const myPostsCount = posts.filter(p => p.user_id === userId).length

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4 text-center">
          <div className="text-6xl mb-4">💬</div>
          <h1 className="text-3xl font-bold text-white mb-4">Community Forum</h1>
          <p className="text-indigo-200 mb-6">Please log in to view and join the discussion.</p>
          <Link href="/login" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-indigo-900">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        
        <div className="relative overflow-hidden bg-gradient-to-r from-purple-700 via-fuchsia-700 to-pink-700 px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="absolute top-0 right-0 w-72 h-72 bg-yellow-300/10 rounded-full blur-3xl -mr-20 -mt-20"></div>
          <div className="absolute bottom-0 left-0 w-56 h-56 bg-blue-400/10 rounded-full blur-3xl -ml-20 -mb-20"></div>
          <div className="max-w-5xl mx-auto relative">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
              <div>
                <div className="inline-flex items-center gap-2 bg-white/15 backdrop-blur px-3 py-1 rounded-full text-xs font-semibold text-white mb-3">
                  <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                  {posts.length} active {posts.length === 1 ? 'discussion' : 'discussions'}
                </div>
                <h1 className="text-3xl sm:text-4xl font-black text-white mb-2">Community Forum</h1>
                <p className="text-sm sm:text-base text-purple-100 max-w-xl">Connect with fellow CRNA applicants — ask questions, share experiences, and support each other through the journey.</p>
              </div>
              <button
                onClick={() => setShowNewPost(true)}
                className="w-full sm:w-auto px-6 py-3.5 bg-white text-purple-700 font-bold rounded-2xl hover:bg-yellow-300 hover:scale-105 transition-all shadow-xl whitespace-nowrap"
              >
                ✍️ Start a Discussion
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">

          <div className="bg-gradient-to-r from-red-500/20 to-orange-500/20 border border-red-400/40 rounded-2xl p-4 sm:p-5 mb-6 flex items-start gap-3">
            <span className="text-2xl flex-shrink-0">🚫</span>
            <div>
              <p className="text-red-200 font-semibold text-sm sm:text-base">School-Specific Interview Tips Are Not Allowed to Be Shared Here</p>
              <p className="text-red-200/70 text-xs sm:text-sm mt-0.5">This content is reserved for the School Interview Styles section. Violators will be banned from our platform.</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="flex gap-2 bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-1.5 w-fit">
              <button
                onClick={() => setFilterMode('all')}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
                  filterMode === 'all' ? 'bg-white text-purple-700 shadow-md' : 'text-white/70 hover:text-white'
                }`}
              >
                All Posts
              </button>
              <button
                onClick={() => setFilterMode('mine')}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition relative ${
                  filterMode === 'mine' ? 'bg-white text-purple-700 shadow-md' : 'text-white/70 hover:text-white'
                }`}
              >
                My Posts ({myPostsCount})
                {newReplyPostIds.size > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                    {newReplyPostIds.size}
                  </span>
                )}
              </button>
            </div>

            <div className="relative flex-1">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search discussions..."
                className="w-full pl-12 pr-4 py-3 bg-white/10 backdrop-blur border border-white/20 rounded-2xl text-white placeholder-indigo-300 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:bg-white/15 transition"
              />
            </div>
          </div>

          {filteredPosts.length === 0 ? (
            <div className="text-center py-20 bg-white/5 border border-white/10 rounded-3xl">
              <div className="text-6xl mb-4">{filterMode === 'mine' ? '📭' : '🌱'}</div>
              <p className="text-indigo-100 text-lg font-semibold mb-1">
                {filterMode === 'mine' ? 'You haven\'t posted yet' : posts.length === 0 ? 'No discussions yet' : 'No matching discussions'}
              </p>
              <p className="text-indigo-300 text-sm">
                {filterMode === 'mine' ? 'Start a discussion to see it here!' : posts.length === 0 ? 'Be the first to start a conversation!' : 'Try a different search term'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredPosts.map((post) => (
                <Link key={post.id} href={`/forum/${post.id}`}>
                  <div className="group bg-white/95 backdrop-blur rounded-2xl shadow-lg p-5 sm:p-6 hover:shadow-2xl hover:bg-white transition-all duration-200 hover:-translate-y-0.5 border border-transparent hover:border-purple-200 relative">
                    {newReplyPostIds.has(post.id) && (
                      <span className="absolute -top-2 -right-2 bg-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-md animate-pulse">
                        NEW REPLY
                      </span>
                    )}
                    <div className="flex items-start gap-4">
                      <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br ${getAvatarColor(post.user_email)} flex items-center justify-center text-white font-bold text-lg flex-shrink-0 shadow-md`}>
                        {getInitial(post.user_email)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h2 className="font-bold text-gray-900 text-base sm:text-lg mb-1 truncate group-hover:text-purple-600 transition-colors">{post.title}</h2>
                        <p className="text-gray-500 text-sm line-clamp-2 mb-3 leading-relaxed">{post.content}</p>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="font-semibold text-purple-600">{getDisplayName(post.user_email)}</span>
                          <span className="text-gray-300">•</span>
                          <span className="text-gray-400">{formatTime(post.created_at)}</span>
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-center bg-gradient-to-br from-purple-50 to-pink-50 rounded-2xl px-3.5 py-2.5 min-w-[64px] group-hover:from-purple-100 group-hover:to-pink-100 transition-colors">
                        <div className="text-lg font-black text-purple-600">{replyCounts[post.id] || 0}</div>
                        <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{replyCounts[post.id] === 1 ? 'reply' : 'replies'}</div>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {showNewPost && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full p-6 sm:p-7 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-3xl">✍️</span>
              <h2 className="text-xl font-black text-gray-900">Start a New Discussion</h2>
            </div>
            <p className="text-gray-400 text-sm mb-5">Ask a question or share something with the community</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Title</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="What's your question or topic?"
                  className="w-full px-4 py-3 border-2 border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-300 text-sm transition"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Details</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Share more details..."
                  rows={6}
                  className="w-full px-4 py-3 border-2 border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-300 text-sm resize-none transition"
                />
              </div>
              <div className="bg-red-50 border border-red-100 rounded-xl p-3 flex items-start gap-2">
                <span className="text-red-500 flex-shrink-0">🚫</span>
                <p className="text-xs text-red-600">Reminder: School-specific interview tips are not allowed here. Violators will be banned.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowNewPost(false)} className="flex-1 py-3 border-2 border-gray-100 rounded-xl text-gray-600 font-semibold hover:bg-gray-50 transition">Cancel</button>
              <button onClick={createPost} disabled={submitting} className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition disabled:opacity-50 shadow-lg">
                {submitting ? 'Posting...' : 'Post Discussion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
