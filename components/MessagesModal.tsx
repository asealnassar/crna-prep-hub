'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase-browser'

interface MessagesModalProps {
  userEmail: string
  isAdmin: boolean
}

type View = 'compose'

export default function MessagesModal({ userEmail, isAdmin }: MessagesModalProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [threads, setThreads] = useState<any[]>([])
  const [selectedThread, setSelectedThread] = useState<any>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [allUsers, setAllUsers] = useState<any[]>([])
  const [adminId, setAdminId] = useState<string>('')
  const [showCompose, setShowCompose] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [messageFilter, setMessageFilter] = useState<'all' | 'unread' | 'read'>('all')
  
  const [compose, setCompose] = useState({
    subject: '',
    message: '',
    recipientType: 'user' as 'admin' | 'user' | 'tier',
    selectedUserId: '',
    selectedTier: 'free'
  })

  const supabase = createClient()

  useEffect(() => {
    const handleOpen = () => {
      setIsOpen(true)
      loadThreads()
      if (isAdmin) loadUsers()
      getAdminId()
    }
    window.addEventListener('openMessages' as any, handleOpen)
    return () => window.removeEventListener('openMessages' as any, handleOpen)
  }, [])

  useEffect(() => {
    loadThreads()
    if (isAdmin) loadUsers()
    getAdminId()
    
    const interval = setInterval(() => {
      loadThreads()
    }, 5000)
    
    return () => clearInterval(interval)
  }, [])

  const getAdminId = async () => {
    const { data } = await supabase.rpc('get_admin_user_id')
    setAdminId(data)
  }

  const loadUsers = async () => {
    const { data } = await supabase
      .from('user_profiles')
      .select('id, email, subscription_tier')
      .order('email')
    
    setAllUsers(data || [])
  }

  const getTierBadge = (tier: string) => {
    switch (tier) {
      case 'free': return 'F'
      case 'premium': return 'P'
      case 'ultimate': return 'U'
      default: return 'F'
    }
  }

  const updateSidebarBadge = (count: number) => {
    const badge = document.getElementById('messages-unread-badge')
    if (badge) {
      if (count > 0) {
        badge.textContent = count.toString()
        badge.classList.remove('hidden')
      } else {
        badge.classList.add('hidden')
      }
    }
  }

  const loadThreads = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: myParticipations } = await supabase
      .from('thread_participants')
      .select('thread_id')
      .eq('user_id', user.id)
      .is('deleted_at', null)

    if (!myParticipations || myParticipations.length === 0) {
      setThreads([])
      updateSidebarBadge(0)
      return
    }

    const threadIds = myParticipations.map(p => p.thread_id)

    const { data: threadsData } = await supabase
      .from('message_threads')
      .select('*')
      .in('id', threadIds)
      .order('updated_at', { ascending: false })

    if (!threadsData) {
      setThreads([])
      updateSidebarBadge(0)
      return
    }

    const processedThreads = await Promise.all(
      threadsData.map(async (thread: any) => {
        const { data: participants } = await supabase
          .from('thread_participants')
          .select('user_id')
          .eq('thread_id', thread.id)
          .neq('user_id', user.id)

        const otherUserId = participants?.[0]?.user_id

let otherEmail = 'Unknown'
        if (otherUserId) {
          const { data: profile } = await supabase
            .from('user_profiles')
            .select('email')
            .eq('id', otherUserId)
            .single()
          
          // Show "CRNA PREP HUB Admin Team" if messaging admin
          if (profile?.email === 'asealnassar@gmail.com') {
            otherEmail = 'CRNA PREP HUB Admin Team'
          } else {
            otherEmail = profile?.email || 'Unknown'
          }
        }
        const { data: lastMsg } = await supabase
          .from('thread_messages')
          .select('message_text, created_at')
          .eq('thread_id', thread.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()

        // Track 1: Messages YOU haven't read (for blue dot indicator)
        const { data: unreadMsgs } = await supabase
          .from('thread_messages')
          .select('id')
          .eq('thread_id', thread.id)
          .neq('sender_id', user.id)

        let unreadCount = 0
        if (unreadMsgs && unreadMsgs.length > 0) {
          for (const msg of unreadMsgs) {
            const { data: readStatuses } = await supabase
              .from('message_read_status')
              .select('read_at')
              .eq('message_id', msg.id)
              .eq('user_id', user.id)
            
            if (!readStatuses || readStatuses.length === 0 || !readStatuses[0]?.read_at) {
              unreadCount++
            }
          }
        }

        // Track 2: Whether THEY read YOUR last message (for filtering)
        let recipientHasRead = true // Default to true
        if (lastMsg) {
          const { data: lastMsgFull } = await supabase
            .from('thread_messages')
            .select('sender_id, id')
            .eq('thread_id', thread.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single()

          if (lastMsgFull && lastMsgFull.sender_id === user.id) {
            // You sent the last message - check if recipient read it
            const { data: readStatus } = await supabase
              .from('message_read_status')
              .select('read_at')
              .eq('message_id', lastMsgFull.id)
              .neq('user_id', user.id)
              .single()

            recipientHasRead = !!readStatus?.read_at
          }
        }

        return {
          ...thread,
          otherParticipantEmail: otherEmail,
          unreadCount: unreadCount,
          recipientHasRead: recipientHasRead,
          lastMessage: lastMsg?.message_text || '',
          lastMessageTime: lastMsg?.created_at || thread.created_at
        }
      })
    )

    setThreads(processedThreads)
    const totalUnread = processedThreads.filter(t => t.unreadCount > 0).length
    updateSidebarBadge(totalUnread)
  }

  const loadThread = async (threadId: string) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: allMessages } = await supabase
      .from('thread_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })

    if (allMessages) {
      for (const msg of allMessages) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('email')
          .eq('id', msg.sender_id)
          .single()
        msg.senderEmail = profile?.email || 'Unknown'
      }
    }

    const { data: deletions } = await supabase
      .from('message_deletions')
      .select('message_id')
      .eq('user_id', user.id)

    const deletedIds = deletions?.map(d => d.message_id) || []
    const messagesData = allMessages?.filter(msg => !deletedIds.includes(msg.id)) || []

    if (!messagesData || messagesData.length === 0) {
      setMessages([])
      return
    }

    const messagesWithStatus = await Promise.all(
      messagesData.map(async (msg: any) => {
        if (msg.sender_id === user.id) {
          const { data: readStatus } = await supabase
            .from('message_read_status')
            .select('*')
            .eq('message_id', msg.id)
            .neq('user_id', msg.sender_id)
            .single()

          let messageStatus = 'sent'
          if (readStatus?.delivered_at) messageStatus = 'delivered'
          if (readStatus?.read_at) messageStatus = 'read'

          return {
            ...msg,
            status: messageStatus,
            senderEmail: msg.senderEmail
          }
        } else {
          return {
            ...msg,
            status: 'received',
            senderEmail: msg.senderEmail
          }
        }
      })
    )

    setMessages(messagesWithStatus)

    for (const msg of messagesData) {
      if (msg.sender_id !== user.id) {
        await supabase
          .from('message_read_status')
          .update({ read_at: new Date().toISOString() })
          .eq('message_id', msg.id)
          .eq('user_id', user.id)
      }
    }

    const { data: threadData } = await supabase
      .from('message_threads')
      .select('*')
      .eq('id', threadId)
      .single()

    setSelectedThread(threadData)
    setShowCompose(false)
    loadThreads()
  }

  const sendReply = async () => {
    if (!replyText.trim() || !selectedThread) return

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    setSending(true)

    const { data: newMessage } = await supabase
      .from('thread_messages')
      .insert({
        thread_id: selectedThread.id,
        sender_id: user.id,
        message_text: replyText
      })
      .select()
      .single()

    const { data: participants } = await supabase
      .from('thread_participants')
      .select('user_id')
      .eq('thread_id', selectedThread.id)
      .neq('user_id', user.id)

    if (participants && newMessage) {
      for (const p of participants) {
        await supabase.from('message_read_status').insert({
          message_id: newMessage.id,
          user_id: p.user_id,
          delivered_at: new Date().toISOString()
        })
      }
    }

    await supabase
      .from('message_threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', selectedThread.id)

    setReplyText('')
    setSending(false)
    loadThread(selectedThread.id)
  }

  const composeMessage = async () => {
    if (!compose.subject || !compose.message) {
      alert('Subject and message are required')
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    setSending(true)

    try {
      if (compose.recipientType === 'tier' && isAdmin) {
        const { data: count } = await supabase.rpc('send_tier_broadcast', {
          p_subject: compose.subject,
          p_message_text: compose.message,
          p_tier: compose.selectedTier
        })

        alert(`Message sent to ${count} users in ${compose.selectedTier} tier`)
      } else {
        let recipientId
        if (isAdmin) {
          recipientId = compose.selectedUserId
          if (!recipientId) {
            alert('Please select a recipient')
            setSending(false)
            return
          }
        } else {
          recipientId = adminId
          if (!recipientId) {
            alert('Admin user not found')
            setSending(false)
            return
          }
        }

await supabase.rpc('create_thread_with_message', {
          p_subject: compose.subject,
          p_recipient_ids: [recipientId],
          p_message_text: compose.message
        })

        // Send email notification
        fetch('/api/messages/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientId: recipientId,
            senderName: isAdmin ? 'CRNA Prep Hub Admin' : userEmail,
            messagePreview: compose.message.substring(0, 150) + (compose.message.length > 150 ? '...' : '')
          })
        }).catch(err => console.error('Email notification failed:', err))
      }
      setCompose({
        subject: '',
        message: '',
        recipientType: isAdmin ? 'user' : 'admin',
        selectedUserId: '',
        selectedTier: 'free'
      })
      setSending(false)
      setShowCompose(false)
      loadThreads()
    } catch (error) {
      console.error('Error sending message:', error)
      alert('Failed to send message')
      setSending(false)
    }
  }

  const deleteThread = async (threadId: string) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    await supabase
      .from('thread_participants')
      .update({ deleted_at: new Date().toISOString() })
      .eq('thread_id', threadId)
      .eq('user_id', user.id)

    loadThreads()
    if (selectedThread?.id === threadId) {
      setSelectedThread(null)
    }
  }

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <>
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/10 backdrop-blur-sm z-40 transition-all duration-200"
          onClick={() => setIsOpen(false)}
        />
      )}

      <div className={`fixed bottom-0 left-64 h-[85vh] w-[920px] bg-white shadow-xl z-50 transform transition-all duration-300 ease-out rounded-tl-3xl rounded-tr-3xl border border-gray-200/80 ${
        isOpen ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
      }`}>
        
        <div className="h-full flex overflow-hidden rounded-tl-3xl rounded-tr-3xl">
          {/* LEFT SIDEBAR - Conversations List */}
          <div className="w-[340px] border-r border-gray-200/60 flex flex-col bg-gradient-to-b from-gray-50/50 to-white shadow-sm">
            {/* Header */}
            <div className="h-[72px] px-5 flex items-center justify-between border-b border-gray-200/60 bg-white/80 backdrop-blur-sm">
              <h2 className="font-semibold text-gray-900 text-[17px] tracking-tight">Messages</h2>
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    setShowCompose(true)
                    setSelectedThread(null)
                  }}
                  className="p-2.5 hover:bg-gray-100 rounded-xl transition-all duration-150 group"
                  title="New Message"
                >
                  <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-900 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                  </svg>
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2.5 hover:bg-gray-100 rounded-xl transition-all duration-150 group"
                >
                  <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-900 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Search Bar */}
            <div className="px-3 py-3 border-b border-gray-200/60 bg-white">
              <div className="relative mb-2">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-200 rounded transition-all duration-150"
                  >
                    <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              
              {/* Filter Buttons */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => setMessageFilter('all')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                    messageFilter === 'all'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setMessageFilter('unread')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                    messageFilter === 'unread'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Unread
                </button>
                <button
                  onClick={() => setMessageFilter('read')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                    messageFilter === 'read'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Read
                </button>
              </div>
            </div>

            {/* Conversations */}
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const filteredThreads = threads
                  .filter(thread => 
                    thread.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    thread.otherParticipantEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    thread.lastMessage.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                  .filter(thread => {
                    if (messageFilter === 'unread') return !thread.recipientHasRead
                    if (messageFilter === 'read') return thread.recipientHasRead
                    return true // 'all'
                  })

                if (filteredThreads.length === 0) {
                  return (
                    <div className="p-12 text-center">
                      {searchQuery || messageFilter !== 'all' ? (
                        <>
                          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center ring-1 ring-gray-200/50">
                            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                            </svg>
                          </div>
                          <p className="text-sm font-medium text-gray-900 mb-1">No results found</p>
                          <p className="text-xs text-gray-500">Try a different search or filter</p>
                        </>
                      ) : (
                        <>
                          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center ring-1 ring-blue-100/50">
                            <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                            </svg>
                          </div>
                          <p className="text-sm font-medium text-gray-900 mb-1">No messages yet</p>
                          <p className="text-xs text-gray-500 mb-4">Start a conversation to connect</p>
                          <button
                            onClick={() => {
                              setShowCompose(true)
                              setSelectedThread(null)
                            }}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 transition-all duration-150 shadow-sm hover:shadow"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                            </svg>
                            New Message
                          </button>
                        </>
                      )}
                    </div>
                  )
                }

                return (
                  <div className="py-1">
                    {filteredThreads.map((thread) => (
                      <div
                        key={thread.id}
                        onClick={() => loadThread(thread.id)}
                        className={`mx-2 my-0.5 px-3 py-3 cursor-pointer transition-all duration-150 group hover:bg-white hover:shadow-sm rounded-xl relative ${
                          selectedThread?.id === thread.id ? 'bg-white shadow-sm ring-1 ring-blue-500/20' : ''
                        }`}
                      >
                        {selectedThread?.id === thread.id && (
                          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-blue-600 rounded-r-full"></div>
                        )}
                        
                        <div className="flex items-start justify-between mb-1.5">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 shadow-sm ring-1 ring-black/5">
                              {thread.otherParticipantEmail[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5">
                                <h3 className={`text-sm font-semibold truncate ${thread.unreadCount > 0 ? 'text-gray-900' : 'text-gray-700'}`}>
                                  {thread.subject}
                                </h3>
                                {thread.unreadCount > 0 && (
                                  <span className="w-2 h-2 bg-blue-600 rounded-full flex-shrink-0 ring-2 ring-white"></span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 truncate font-medium">{thread.otherParticipantEmail}</p>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 flex-shrink-0 ml-3">
                            <span className="text-[11px] font-medium text-gray-400">{formatTime(thread.lastMessageTime)}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm('Delete this conversation?')) {
                                  deleteThread(thread.id)
                                }
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-all duration-150 p-1.5 hover:bg-red-50 rounded-lg"
                            >
                              <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <p className={`text-[13px] leading-relaxed truncate pl-14 ${thread.unreadCount > 0 ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>
                          {thread.lastMessage}
                        </p>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          </div>

          {/* RIGHT PANEL - Chat Thread or Compose */}
          <div className="flex-1 flex flex-col bg-white">
            {showCompose ? (
              /* COMPOSE VIEW */
              <div className="flex-1 flex flex-col">
                <div className="h-[72px] px-6 flex items-center border-b border-gray-200/60 bg-white/80 backdrop-blur-sm">
                  <h2 className="font-semibold text-gray-900 text-[17px] tracking-tight">New Message</h2>
                </div>
                
                <div className="flex-1 overflow-y-auto p-8">
                  <div className="max-w-2xl space-y-6">
                    {isAdmin ? (
                      <>
                        <div>
                          <label className="block text-sm font-semibold text-gray-900 mb-3">Send To</label>
                          <div className="flex gap-3">
                            <button
                              onClick={() => setCompose({ ...compose, recipientType: 'user' })}
                              className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150 ${
                                compose.recipientType === 'user' 
                                  ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-600' 
                                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200'
                              }`}
                            >
                              Individual User
                            </button>
                            <button
                              onClick={() => setCompose({ ...compose, recipientType: 'tier' })}
                              className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150 ${
                                compose.recipientType === 'tier' 
                                  ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-600' 
                                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200'
                              }`}
                            >
                              Tier Broadcast
                            </button>
                          </div>
                        </div>

                        {compose.recipientType === 'user' ? (
                          <div>
                            <label className="block text-sm font-semibold text-gray-900 mb-3">Recipient</label>
                            <select
                              value={compose.selectedUserId}
                              onChange={(e) => setCompose({ ...compose, selectedUserId: e.target.value })}
                              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 bg-white text-sm"
                            >
                              <option value="">Select a user...</option>
                              {allUsers.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.email} [{getTierBadge(u.subscription_tier)}]
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div>
                            <label className="block text-sm font-semibold text-gray-900 mb-3">Tier</label>
                            <select
                              value={compose.selectedTier}
                              onChange={(e) => setCompose({ ...compose, selectedTier: e.target.value })}
                              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 bg-white text-sm"
                            >
                              <option value="free">Free Tier</option>
                              <option value="premium">Premium Tier</option>
                              <option value="ultimate">Ultimate Tier</option>
                            </select>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 ring-1 ring-blue-500/10">
                        <p className="text-sm font-medium text-blue-900">Sending to Admin</p>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-semibold text-gray-900 mb-3">Subject</label>
                      <input
                        type="text"
                        value={compose.subject}
                        onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                        placeholder="What's this about?"
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-gray-900 mb-3">Message</label>
                      <textarea
                        value={compose.message}
                        onChange={(e) => setCompose({ ...compose, message: e.target.value })}
                        placeholder="Type your message..."
                        rows={8}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 text-sm leading-relaxed"
                      />
                    </div>

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={composeMessage}
                        disabled={sending}
                        className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow"
                      >
                        {sending ? 'Sending...' : 'Send Message'}
                      </button>
                      <button
                        onClick={() => setShowCompose(false)}
                        className="px-6 py-3 bg-gray-50 text-gray-700 rounded-xl font-medium hover:bg-gray-100 transition-all duration-150 border border-gray-200"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : selectedThread ? (
              /* CHAT THREAD VIEW */
              <>
                {/* Chat Header */}
                <div className="h-[72px] px-6 flex items-center justify-between border-b border-gray-200/60 bg-white/80 backdrop-blur-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold shadow-sm ring-1 ring-black/5">
                      {threads.find(t => t.id === selectedThread.id)?.otherParticipantEmail[0].toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 text-[15px]">{selectedThread.subject}</h3>
                      <p className="text-xs text-gray-500 font-medium">{threads.find(t => t.id === selectedThread.id)?.otherParticipantEmail}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm('Delete this conversation?')) {
                        deleteThread(selectedThread.id)
                      }
                    }}
                    className="p-2.5 hover:bg-red-50 rounded-xl transition-all duration-150 group"
                  >
                    <svg className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-6 bg-gradient-to-b from-gray-50/30 to-white">
                  {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center">
                      <p className="text-gray-400 text-sm">No messages yet</p>
                    </div>
                  ) : (
                    <div className="space-y-4 max-w-4xl mx-auto">
                      {messages.map((msg) => {
                        const isMyMessage = msg.senderEmail === userEmail
                        
                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isMyMessage ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-200`}
                          >
                            <div className={`max-w-[65%] ${isMyMessage ? 'items-end' : 'items-start'} flex flex-col`}>
                              <div
                                className={`px-4 py-3 rounded-2xl shadow-sm transition-all duration-150 hover:shadow ${
                                  isMyMessage
                                    ? 'bg-blue-600 text-white rounded-br-md'
                                    : 'bg-white text-gray-900 rounded-bl-md border border-gray-200/80'
                                }`}
                              >
                                <p className="text-[14px] leading-relaxed whitespace-pre-line">{msg.message_text}</p>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1.5 px-1">
                                <span className={`text-[11px] font-medium ${isMyMessage ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {formatTime(msg.created_at)}
                                </span>
                                {isMyMessage && (
                                  <span className="text-[11px] text-gray-500">
                                    {msg.status === 'read' && '✓✓'}
                                    {msg.status === 'delivered' && '✓'}
                                    {msg.status === 'sent' && '·'}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Input Area */}
                <div className="px-6 py-5 border-t border-gray-200/60 bg-white/80 backdrop-blur-sm">
                  <div className="flex gap-3 items-end">
                    <div className="flex-1">
                      <textarea
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            sendReply()
                          }
                        }}
                        placeholder="Type a message..."
                        rows={1}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 text-[14px] leading-relaxed"
                        style={{ minHeight: '44px', maxHeight: '120px' }}
                      />
                    </div>
                    <button
                      onClick={sendReply}
                      disabled={sending || !replyText.trim()}
                      className="w-11 h-11 bg-blue-600 text-white rounded-xl flex items-center justify-center hover:bg-blue-700 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 shadow-sm hover:shadow"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* EMPTY STATE */
              <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-gray-50/30 to-white">
                <div className="text-center max-w-sm px-6">
                  <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center ring-1 ring-blue-100/50 shadow-sm">
                    <svg className="w-12 h-12 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Select a conversation</h3>
                  <p className="text-sm text-gray-500 leading-relaxed">Choose a message from the sidebar to view the conversation and continue chatting</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
