'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function Interview() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const [userTier, setUserTier] = useState('free')
  const [interviewCount, setInterviewCount] = useState(0)
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [pageLoading, setPageLoading] = useState(true)
  const [interviewType, setInterviewType] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [questionCount, setQuestionCount] = useState(0)
  const [interviewEnded, setInterviewEnded] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [askedQuestions, setAskedQuestions] = useState<string[]>([])
  const [recentQuestions, setRecentQuestions] = useState<string[]>([])
  const [sessionId, setSessionId] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [sendingFeedback, setSendingFeedback] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [interviewHistory, setInterviewHistory] = useState<any[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('all')
  const [filterReviewed, setFilterReviewed] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'
  const canInterview = isLoggedIn && (isUltimate || interviewCount < 1)
  const maxQuestions = 10

  const interviewTypes = [
    { id: 'emotional', name: 'Emotional Intelligence', icon: '🧠', description: 'Questions about self-awareness, empathy, and interpersonal skills' },
    { id: 'clinical', name: 'Clinical', icon: '🏥', description: 'Medical scenarios and clinical decision-making questions' },
    { id: 'mixed', name: 'Mixed', icon: '🎯', description: 'A combination of all question types' },
    { id: 'custom', name: 'Custom Topic', icon: '✨', description: 'Choose your own interview focus' },
  ]

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier, interview_count').eq('id', user.id).single()
        if (profile) {
          setUserTier(profile.subscription_tier || 'free')
          setInterviewCount(profile.interview_count || 0)
        }
        await loadInterviewHistory(user.id)
      }
      setPageLoading(false)
    }
    init()
  }, [])

  const loadInterviewHistory = async (uid: string) => {
    const { data } = await supabase
      .from('interview_sessions')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })

    setInterviewHistory(data || [])
  }

  const saveSession = async () => {
    if (!userId || messages.length === 0) return

    const sessionData = {
      user_id: userId,
      school_type: interviewType,
      interview_type: customTopic || interviewType,
      conversation: messages,
      question_count: questionCount,
      reviewed: false,
    }

    if (currentSessionId) {
      await supabase
        .from('interview_sessions')
        .update(sessionData)
        .eq('id', currentSessionId)
    } else {
      const { data } = await supabase
        .from('interview_sessions')
        .insert(sessionData)
        .select()
        .single()

      if (data) setCurrentSessionId(data.id)
    }

    if (userId) await loadInterviewHistory(userId)
  }

  const markAsReviewed = async (sessionId: string) => {
    await supabase
      .from('interview_sessions')
      .update({ reviewed: true })
      .eq('id', sessionId)

    if (userId) await loadInterviewHistory(userId)
  }

  const loadRecentQuestions = async (type: string) => {
    if (!userId) return []
    const thirtyDixHoursAgo = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('user_asked_questions')
      .select('question')
      .eq('user_id', userId)
      .eq('interview_type', type)
      .gte('asked_at', thirtyDixHoursAgo)
    return data?.map(d => d.question) || []
  }

  const saveQuestion = async (question: string, type: string) => {
    if (!userId) return
    await supabase.from('user_asked_questions').insert({
      user_id: userId,
      interview_type: type,
      question: question
    })
  }

  const extractQuestion = (text: string): string => {
    const match = text.match(/Question \d+:([\s\S]*?)(?=\n\nScore:|What you did|$)/)
    if (match) {
      return match[1].trim()
    }
    const lines = text.split('\n')
    for (const line of lines) {
      if (line.includes('?')) {
        return line.trim()
      }
    }
    return text.substring(0, 200)
  }

  const submitFeedback = async () => {
    if (!feedbackMessage.trim()) return
    setSendingFeedback(true)
    await supabase.from('interview_feedback').insert({
      user_email: userEmail || 'anonymous',
      message: feedbackMessage
    })
    setSendingFeedback(false)
    setFeedbackSent(true)
    setFeedbackMessage('')
  }

  const getSystemMessage = () => {
    const randomSeed = Math.random().toString(36).substring(7) + Date.now()

    const avoidList = questionCount === 1 && recentQuestions.length > 0
      ? `\n\nRECENT SCENARIOS TO AVOID (asked in last 36 hours):
${recentQuestions.slice(0, 20).map((q, i) => `${i + 1}. ${q}`).join('\n')}

Generate DIFFERENT scenarios using the random seed below.\n`
      : ''

let basePrompt = `You are conducting a CRNA program interview for ICU nurses applying to CRNA school. This is question ${questionCount + 1} of ${maxQuestions}.

RANDOM SEED: ${randomSeed} - Use this to generate variety. Do NOT default to the same scenarios.

CRITICAL SCORING RULES:
- Be HONEST and ACCURATE in your scoring
- Random letters, one-word answers, or nonsense = 0-1/10
- Vague or incomplete answers = 2-4/10
- Adequate answers = 5-6/10
- Good answers = 7-8/10
- Excellent answers = 9-10/10
- If answer is gibberish or makes no sense, say so directly in feedback

FORMATTING:
- Plain text only (no asterisks, no markdown)
- Keep questions SHORT and realistic

INTERVIEW STRUCTURE:

QUESTION 1:
"Welcome to CRNA Prep Hub. I'll be conducting your interview today. After each answer, I'll provide a score (1-10), feedback, and an elite-level example. Let's begin.

Question 1: [ASK SHORT QUESTION]"

QUESTIONS 2-9:
After each answer:

Score: X/10

What you did well:
- [2-3 strengths - if answer was good quality]
- [If answer was poor/nonsense, say: "Your answer did not address the question" or "Your response was unclear"]

What to tighten:
- [2-3 specific improvements needed]
- [For nonsense answers: "Please provide a coherent, relevant response"]

Elite-level version:
"[Perfect answer]"

[Then ask next question]

QUESTION 10:
After their answer:
- Score: X/10
- What you did well
- What to tighten
- Elite-level version
- Overall interview score: X/10
- Final summary (2-3 sentences)
- "This concludes your interview. Good luck with your CRNA applications!"

${avoidList}`
    switch (interviewType) {
      case 'emotional':
        return basePrompt + `

Ask realistic behavioral questions that CRNA programs use to assess ICU nurses. Keep short and conversational.

Example: "Tell me about a time you disagreed with a physician's order. How did you handle it?"`

      case 'clinical':
        return basePrompt + `

Ask SHORT clinical scenarios that CRNA programs use to assess ICU nurses' critical care knowledge.

Context: These are experienced ICU nurses applying to become CRNAs. Ask about ICU/critical care situations they would have encountered.

IMPORTANT: Use ICU dosing conventions:
- Pressors: mcg/min (NOT mcg/kg/min) - Example: "norepinephrine 12 mcg/min"
- Drips: mcg/min or mg/hr - Example: "propofol 30 mcg/kg/min" or "fentanyl 100 mcg/hr"

Example: "Your septic patient is on norepinephrine 18 mcg/min and MAP is still 55. What's your next move?"

Generate unique, varied clinical questions. Use the random seed to ensure variety.`

      case 'mixed':
        return basePrompt + ` Alternate between behavioral and clinical questions appropriate for ICU nurses applying to CRNA school.`

      case 'custom':
        return basePrompt + ` Focus on: ${customTopic}

Ask short, realistic questions related to this topic for ICU nurses applying to CRNA school.`

      default:
        return basePrompt
    }
  }

  const startInterview = async () => {
    if (!canInterview || !interviewType) return
    if (interviewType === 'custom' && !customTopic.trim()) { alert('Please enter a custom topic'); return }
    
    const recent = await loadRecentQuestions(interviewType)
    setRecentQuestions(recent)
    
    setStarted(true)
    setLoading(true)
    setQuestionCount(1)
    setAskedQuestions([])
    setSessionId(Date.now().toString(36) + Math.random().toString(36).substring(2))
    setCurrentSessionId(null)
    if (!isUltimate && userId) {
      await supabase.from('user_profiles').update({ interview_count: interviewCount + 1 }).eq('id', userId)
      setInterviewCount(interviewCount + 1)
    }
    try {
      const response = await fetch('/api/interview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Start the interview with the welcome message and first question.' }], systemMessage: getSystemMessage() }) })
      const data = await response.json()
      setMessages([{ role: 'assistant', content: data.message }])
      
      const q = extractQuestion(data.message)
      setAskedQuestions([q])
      await saveQuestion(q, interviewType)
      
      setTimeout(() => saveSession(), 1000)
    } catch (error) {
      setMessages([{ role: 'assistant', content: 'Welcome to CRNA Prep Hub. I will be conducting your interview today. Let\'s begin.\n\nQuestion 1: Describe a stressful situation you faced in your nursing career and how you handled it.' }])
    }
    setLoading(false)
  }

const sendMessage = async () => {
    if (!input.trim() || loading || interviewEnded) return
    const newMessages = [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    const newQuestionCount = questionCount + 1
    setQuestionCount(newQuestionCount)
    
    // Always get AI feedback, even for question 10
    try {
      const response = await fetch('/api/interview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: newMessages, systemMessage: getSystemMessage() }) })
      const data = await response.json()
      const updatedMessages = [...newMessages, { role: 'assistant', content: data.message }]
      setMessages(updatedMessages)
      
      const q = extractQuestion(data.message)
      setAskedQuestions(prev => [...prev, q])
      await saveQuestion(q, interviewType)
      
      setTimeout(() => saveSession(), 1000)
      
      // End interview after question 10 feedback is given
if (newQuestionCount > maxQuestions || data.message.includes('concludes') || data.message.includes('Overall interview score')) {      

        setInterviewEnded(true)
      }
    } catch (error) {
      setMessages([...newMessages, { role: 'assistant', content: 'I apologize, but I encountered an error. Please try again.' }])
    }
    setLoading(false)
  }
  const resetInterview = () => {
    setStarted(false)
    setMessages([])
    setInterviewType('')
    setCustomTopic('')
    setQuestionCount(0)
    setInterviewEnded(false)
    setAskedQuestions([])
    setRecentQuestions([])
    setSessionId('')
    setCurrentSessionId(null)
  }

  if (pageLoading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar 
        isLoggedIn={isLoggedIn} 
        userEmail={userEmail} 
        isAdmin={userEmail === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-end">
          {!isLoggedIn && (
            <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition text-sm">
              Login
            </Link>
          )}
        </div>

        <div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-2 sm:py-3 px-4 text-center">
          <a href="/interview-prep" className="text-black text-xs sm:text-sm font-semibold hover:underline">🚀 NEW: School-Specific Interview Style is NOW LIVE for Ultimate members →</a>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="text-center mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-2">AI Mock Interview</h1>
            <p className="text-sm sm:text-base text-indigo-200">Practice your CRNA interview skills with our AI interviewer</p>
            {isLoggedIn && !isUltimate && (
              <div className="mt-4 inline-block bg-yellow-500/20 border border-yellow-500/50 rounded-lg px-3 sm:px-4 py-2 max-w-lg">
                <p className="text-yellow-200 text-xs sm:text-sm">{interviewCount === 0 ? '🎁 You have 1 free interview available!' : '🔒 You have used your free interview. Upgrade to Ultimate for unlimited interviews!'}</p>
              </div>
            )}
            {isLoggedIn && isUltimate && (
              <div className="mt-4 inline-block bg-green-500/20 border border-green-500/50 rounded-lg px-3 sm:px-4 py-2">
                <p className="text-green-200 text-xs sm:text-sm">✨ Ultimate Plan - Unlimited Interviews</p>
              </div>
            )}
            {!isLoggedIn && (
              <div className="mt-4 inline-block bg-purple-500/20 border border-purple-500/50 rounded-lg px-3 sm:px-4 py-2 max-w-lg">
                <p className="text-purple-200 text-xs sm:text-sm">🎁 Sign up free to get 1 free mock interview! Ultimate members get unlimited.</p>
              </div>
            )}
          </div>
          
          {!started ? (
            <>
              <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 mb-8">
                <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 flex-1">
                  <div className="text-center mb-6 sm:mb-8">
                    <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-purple-600 to-pink-500 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6">
                      <span className="text-3xl sm:text-4xl">🎤</span>
                    </div>
                    <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2">Choose Interview Type</h2>
                    <p className="text-sm sm:text-base text-gray-600">Select the type of interview you want to practice (10 questions max)</p>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-4 sm:mb-6">
                    {interviewTypes.map((type) => (
                      <button key={type.id} onClick={() => setInterviewType(type.id)} className={`p-3 sm:p-4 rounded-xl border-2 text-left transition ${interviewType === type.id ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-purple-300'}`}>
                        <div className="flex items-center gap-2 sm:gap-3 mb-2">
                          <span className="text-xl sm:text-2xl">{type.icon}</span>
                          <h3 className="font-semibold text-gray-800 text-sm sm:text-base">{type.name}</h3>
                        </div>
                        <p className="text-xs sm:text-sm text-gray-600">{type.description}</p>
                      </button>
                    ))}
                  </div>
                  
                  {interviewType === 'custom' && (
                    <div className="mb-4 sm:mb-6">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Enter your custom topic:</label>
                      <input type="text" value={customTopic} onChange={(e) => setCustomTopic(e.target.value)} placeholder="e.g., Leadership experience, Handling difficult patients..." className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base" />
                    </div>
                  )}
                  
                  {!isLoggedIn ? (
                    <div className="text-center">
                      <Link href="/login" className="inline-block w-full py-3 sm:py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-base sm:text-lg text-center">Sign Up Free to Start Interviewing</Link>
                      <p className="text-gray-500 text-xs sm:text-sm mt-3">Get 1 free interview. Upgrade to Ultimate for unlimited.</p>
                    </div>
                  ) : canInterview ? (
                    <button onClick={startInterview} disabled={!interviewType || (interviewType === 'custom' && !customTopic.trim())} className="w-full py-3 sm:py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-base sm:text-lg disabled:opacity-50 disabled:cursor-not-allowed">Start Interview</button>
                  ) : (
                    <div className="text-center">
                      <button disabled className="px-6 sm:px-8 py-3 sm:py-4 bg-gray-400 text-white font-semibold rounded-xl cursor-not-allowed text-base sm:text-lg mb-4">🔒 Interview Used</button>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">You have used your free interview.</p>
                      <Link href="/pricing" className="inline-block px-6 sm:px-8 py-3 sm:py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">Upgrade to Ultimate for Unlimited Interviews</Link>
                    </div>
                  )}
                </div>

                <div className="w-full lg:w-72 bg-white rounded-2xl shadow-xl p-4 sm:p-6 h-fit">
                  <div className="text-center mb-4">
                    <span className="text-2xl sm:text-3xl">💬</span>
                    <h3 className="text-base sm:text-lg font-bold text-gray-800 mt-2">Help Us Improve</h3>
                    <p className="text-xs sm:text-sm text-gray-600 mt-1">Experiencing issues with the AI interview? Let me know!</p>
                  </div>
                  
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
                    <p className="text-xs text-blue-800">📧 I personally read every message and fix all reported issues to make this tool better for you.</p>
                  </div>

                  {feedbackSent ? (
                    <div className="text-center py-4">
                      <span className="text-3xl sm:text-4xl">✅</span>
                      <p className="text-green-600 font-semibold mt-2 text-sm sm:text-base">Thank you!</p>
                      <p className="text-xs sm:text-sm text-gray-600">Your feedback has been received.</p>
                      <button onClick={() => setFeedbackSent(false)} className="mt-3 text-purple-600 text-xs sm:text-sm underline">Send another</button>
                    </div>
                  ) : (
                    <>
                      <textarea
                        value={feedbackMessage}
                        onChange={(e) => setFeedbackMessage(e.target.value)}
                        placeholder="Describe any issues, bugs, or suggestions..."
                        rows={4}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-xs sm:text-sm resize-none"
                      />
                      <button
                        onClick={submitFeedback}
                        disabled={!feedbackMessage.trim() || sendingFeedback}
                        className="w-full mt-3 py-2 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-xs sm:text-sm"
                      >
                        {sendingFeedback ? 'Sending...' : 'Send Feedback'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Interview History - Only when NOT interviewing */}
              {isLoggedIn && interviewHistory.length > 0 && (
                <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">📚 Past Interview Review</h2>
                  
                  {/* Filters */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Interview Type</label>
                      <select 
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      >
                        <option value="all">All Types</option>
                        <option value="emotional">Emotional Intelligence</option>
                        <option value="clinical">Clinical</option>
                        <option value="mixed">Mixed</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Review Status</label>
                      <select 
                        value={filterReviewed}
                        onChange={(e) => setFilterReviewed(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      >
                        <option value="all">All</option>
                        <option value="needs_review">Needs Review</option>
                        <option value="reviewed">Reviewed</option>
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Sort By</label>
                      <select 
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      >
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {(() => {
                      let filtered = interviewHistory
                      
                      if (filterType !== 'all') {
                        filtered = filtered.filter(s => s.school_type === filterType)
                      }
                      
                      if (filterReviewed === 'needs_review') {
                        filtered = filtered.filter(s => !s.reviewed)
                      } else if (filterReviewed === 'reviewed') {
                        filtered = filtered.filter(s => s.reviewed)
                      }
                      
                      if (sortBy === 'oldest') {
                        filtered = [...filtered].reverse()
                      }
                      
                      if (filtered.length === 0) {
                        return <p className="text-center text-gray-400 py-8">No interviews match your filters</p>
                      }
                      
                      return filtered.map((session) => (
                        <div key={session.id} className="border-2 border-gray-200 rounded-xl overflow-hidden">
                          <button
                            onClick={() => setExpandedSession(expandedSession === session.id ? null : session.id)}
                            className="w-full p-4 flex justify-between items-center hover:bg-gray-50 transition"
                          >
                            <div className="text-left">
                              <h3 className="font-bold text-gray-800 text-sm sm:text-base">
                                {interviewTypes.find(t => t.id === session.school_type)?.name || session.school_type}
                                {session.interview_type !== session.school_type && ` - ${session.interview_type}`}
                              </h3>
                              <p className="text-xs text-gray-500">
                                {new Date(session.created_at).toLocaleDateString()} • {session.question_count} questions
                              </p>
                            </div>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  markAsReviewed(session.id)
                                }}
                                className={`px-2 sm:px-3 py-1 rounded-full text-xs font-semibold ${
                                  session.reviewed 
                                    ? 'bg-green-100 text-green-700' 
                                    : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                                }`}
                              >
                                {session.reviewed ? '✓ Reviewed' : '⚠ Review'}
                              </button>
                              <span className="text-gray-400">
                                {expandedSession === session.id ? '▲' : '▼'}
                              </span>
                            </div>
                          </button>

                          {expandedSession === session.id && (
                            <div className="p-4 border-t bg-gray-50 space-y-3 max-h-96 overflow-y-auto">
                              {session.conversation.map((msg: any, msgIdx: number) => (
                                <div key={msgIdx}>
                                  {msg.role === 'assistant' && (
                                    <div className="bg-blue-50 p-3 rounded-lg mb-2">
                                      <div className="text-xs text-blue-600 font-semibold mb-1">INTERVIEWER</div>
                                      <p className="text-xs sm:text-sm text-gray-800 whitespace-pre-line">{msg.content}</p>
                                    </div>
                                  )}
                                  {msg.role === 'user' && (
                                    <div className="bg-purple-50 p-3 rounded-lg">
                                      <div className="text-xs text-purple-600 font-semibold mb-1">YOUR ANSWER</div>
                                      <p className="text-xs sm:text-sm text-gray-800 whitespace-pre-line">{msg.content}</p>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    })()}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="bg-white rounded-2xl shadow-xl overflow-hidden max-w-4xl mx-auto">
              <div className="bg-gradient-to-r from-purple-600 to-pink-500 px-4 sm:px-6 py-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 sm:gap-0">
                <span className="text-white font-medium text-sm sm:text-base">{interviewTypes.find(t => t.id === interviewType)?.name} Interview</span>
                <div className="flex items-center gap-3 sm:gap-4">
                  <span className="text-white/80 text-xs sm:text-sm">Question {Math.min(questionCount, maxQuestions)} of {maxQuestions}</span>
                  <button onClick={resetInterview} className="text-white/80 hover:text-white text-xs sm:text-sm underline transition">Start Over</button>
                </div>
              </div>
              
              <div className="h-80 sm:h-96 overflow-y-auto p-4 sm:p-6 space-y-3 sm:space-y-4">
                {messages.map((msg, index) => (
                  <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] sm:max-w-xs md:max-w-md px-3 sm:px-4 py-2 sm:py-3 rounded-2xl whitespace-pre-line text-sm sm:text-base ${msg.role === 'user' ? 'bg-gradient-to-r from-purple-600 to-pink-500 text-white' : 'bg-gray-100 text-gray-800'}`}>{msg.content}</div>
                  </div>
                ))}
                {loading && (<div className="flex justify-start"><div className="bg-gray-100 text-gray-800 px-3 sm:px-4 py-2 sm:py-3 rounded-2xl text-sm sm:text-base">Thinking...</div></div>)}
              </div>
              
              <div className="border-t p-3 sm:p-4">
                {!interviewEnded ? (
                  <div className="flex gap-2 sm:gap-3">
                    <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendMessage()} placeholder={isListening ? "Listening..." : "Type or click mic..."} className={`flex-1 px-3 sm:px-4 py-2 sm:py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base ${isListening ? 'border-red-500 bg-red-50' : 'border-gray-300'}`} />
<button onClick={() => { 
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) { 
    alert('Speech recognition not supported. Try Chrome.'); 
    return 
  } 
  
  if (isListening) {
    // Stop listening
    (window as any).currentRecognition?.stop()
    setIsListening(false)
    return
  }
  
  // Start listening
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const recognition = new SR()
  recognition.continuous = true  // Keep listening continuously
  recognition.interimResults = true  // Show partial results
  recognition.lang = 'en-US'
  
  recognition.onstart = () => setIsListening(true)
  recognition.onend = () => setIsListening(false)
  recognition.onerror = () => setIsListening(false)
  
  recognition.onresult = (event: any) => { 
    let transcript = ''
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript + ' '
    }
    setInput(transcript.trim())
  }
  
  recognition.start()
  ;(window as any).currentRecognition = recognition
}} className={`px-3 sm:px-4 py-2 sm:py-3 rounded-xl font-semibold transition text-sm sm:text-base ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}>🎤</button>
                    <button onClick={sendMessage} disabled={loading} className="px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50 text-sm sm:text-base">Send</button>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm sm:text-base text-gray-600 mb-4">Interview complete! 🎉</p>
                    {isUltimate && (<button onClick={resetInterview} className="px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">Start New Interview</button>)}
                    {!isUltimate && (<Link href="/pricing" className="inline-block px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">Upgrade for More Interviews</Link>)}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
