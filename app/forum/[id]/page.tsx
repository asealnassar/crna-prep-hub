'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function ForumPostPage() {
  const params = useParams()
  const router = useRouter()
  const postId = params.id as string

  const [post, setPost] = useState<any>(null)
  const [replies, setReplies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userId, setUserId] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [replyText, setReplyText] = useState('')
  const [submitting, setSubmitting] = useState(false)
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
  }, [postId])

  const init = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      setIsLoggedIn(true)
      setUserEmail(user.email || '')
      setUserId(user.id)
      setIsAdmin(user.email === 'asealnassar@gmail.com')
      await loadPost()
      await markAsViewed(user.id)
    } else {
      await loadPost()
    }
    setLoading(false)
  }

  const loadPost = async () => {
    const { data: postData } = await supabase
      .from('forum_posts')
      .select('*')
      .eq('id', postId)
      .single()

    setPost(postData)

    const { data: repliesData } = await supabase
      .from('forum_replies')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true })

    setReplies(repliesData || [])
  }

  const markAsViewed = async (uid: string) => {
    await supabase.from('forum_post_views').upsert({
      post_id: postId,
      user_id: uid,
      last_viewed_at: new Date().toISOString()
    }, { onConflict: 'post_id,user_id' })
  }

  const submitReply = async () => {
    if (!replyText.trim()) return
    setSubmitting(true)
    await supabase.from('forum_replies').insert({
      post_id: postId,
      user_id: userId,
      user_email: userEmail,
      content: replyText
    })
    setReplyText('')
    setSubmitting(false)
    await loadPost()
    await markAsViewed(userId)
  }

  const deletePost = async () => {
    if (!confirm('Delete this post and all its replies?')) return
    await supabase.from('forum_posts').delete().eq('id', postId)
    router.push('/forum')
  }

  const deleteReply = async (replyId: string) => {
    if (!confirm('Delete this reply?')) return
    await supabase.from('forum_replies').delete().eq('id', replyId)
    await loadPost()
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

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4 text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Community Forum</h1>
          <p className="text-indigo-200 mb-6">Please log in to view this discussion.</p>
          <Link href="/login" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  if (!post) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-4">Post not found</p>
          <Link href="/forum" className="text-indigo-300 hover:text-white transition">← Back to Forum</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-indigo-900">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <Link href="/forum" className="inline-flex items-center gap-2 text-indigo-300 hover:text-white transition mb-6 text-sm font-medium">
            ← Back to Forum
          </Link>

          <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-8 mb-6">
            <div className="flex items-start gap-4 mb-5">
              <div className={`w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-gradient-to-br ${getAvatarColor(post.user_email)} flex items-center justify-center text-white font-bold text-xl flex-shrink-0 shadow-md`}>
                {getInitial(post.user_email)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <h1 className="text-xl sm:text-2xl font-black text-gray-900 leading-tight">{post.title}</h1>
                  {(post.user_id === userId || isAdmin) && (
                    <button onClick={deletePost} className="text-red-400 hover:text-red-600 text-xs font-medium flex-shrink-0 mt-1">Delete</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-sm mt-1.5">
                  <span className="font-semibold text-purple-600">{getDisplayName(post.user_email)}</span>
                  <span className="text-gray-300">•</span>
                  <span className="text-gray-400">{formatTime(post.created_at)}</span>
                </div>
              </div>
            </div>
            <p className="text-gray-700 leading-relaxed whitespace-pre-line text-[15px]">{post.content}</p>
          </div>

          <div className="mb-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">💬</span>
              <h2 className="text-white font-bold">{replies.length} {replies.length === 1 ? 'Reply' : 'Replies'}</h2>
            </div>
            <div className="space-y-3">
              {replies.map((reply) => (
                <div key={reply.id} className="bg-white/95 backdrop-blur rounded-2xl p-4 sm:p-5 shadow-md">
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${getAvatarColor(reply.user_email)} flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-sm`}>
                      {getInitial(reply.user_email)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3 mb-1.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-purple-600">{getDisplayName(reply.user_email)}</span>
                          <span className="text-gray-300">•</span>
                          <span className="text-gray-400">{formatTime(reply.created_at)}</span>
                        </div>
                        {(reply.user_id === userId || isAdmin) && (
                          <button onClick={() => deleteReply(reply.id)} className="text-red-400 hover:text-red-600 text-xs flex-shrink-0">Delete</button>
                        )}
                      </div>
                      <p className="text-gray-700 text-sm leading-relaxed whitespace-pre-line">{reply.content}</p>
                    </div>
                  </div>
                </div>
              ))}
              {replies.length === 0 && (
                <div className="text-center py-10 bg-white/5 border border-white/10 rounded-2xl">
                  <div className="text-4xl mb-2">🤔</div>
                  <p className="text-indigo-200 text-sm">No replies yet. Be the first to respond!</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6 sticky bottom-4">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply..."
              rows={3}
              className="w-full px-4 py-3 border-2 border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-300 text-sm resize-none transition"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-gray-400">🚫 No school-specific interview tips allowed</p>
              <button
                onClick={submitReply}
                disabled={submitting || !replyText.trim()}
                className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition disabled:opacity-50 text-sm shadow-lg whitespace-nowrap"
              >
                {submitting ? 'Posting...' : 'Post Reply'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
