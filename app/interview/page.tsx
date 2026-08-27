'use client'

import { useState, useEffect, useRef } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import type { ChatMessage, InterviewMode, InterviewState, InterviewTurnResponse, TurnRender } from '@/lib/interview/types'
import { InterviewMessage } from '@/components/InterviewFeedback'
import {
  ArrowRight,
  Brain,
  Check,
  ChevronRight,
  GraduationCap,
  History,
  MessageSquare,
  Mic,
  RotateCcw,
  Send,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react'

const MAX_PRIMARY_QUESTIONS = 10

/**
 * Set false the first time an insert with the newer columns fails, so we stop
 * paying for a doomed round-trip on every save when the migration hasn't run.
 */
let extendedColumnsAvailable = true

export default function Interview() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
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
  const [interviewMode, setInterviewMode] = useState<InterviewMode>('practice')
  const [customTopic, setCustomTopic] = useState('')
  const [interviewEnded, setInterviewEnded] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [recentQuestions, setRecentQuestions] = useState<string[]>([])
  const [sessionId, setSessionId] = useState('')
  const [engineState, setEngineState] = useState<InterviewState | null>(null)
  const [turnError, setTurnError] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [sendingFeedback, setSendingFeedback] = useState(false)
  const [showFeedbackWidget, setShowFeedbackWidget] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [interviewHistory, setInterviewHistory] = useState<any[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('all')
  const [filterMode, setFilterMode] = useState('all')
  const [filterReviewed, setFilterReviewed] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [showFullHistory, setShowFullHistory] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'
  const canInterview = isLoggedIn && (isUltimate || interviewCount < 1)
  const maxQuestions = MAX_PRIMARY_QUESTIONS
  const questionNumber = Math.min(Math.max(engineState?.primaryQuestionNumber || 1, 1), maxQuestions)
  const onFollowUp = engineState?.turnKind === 'follow_up'

  const interviewTypes: {
    id: string
    name: string
    short: string
    icon: LucideIcon
    accent: string
    lines: string[]
  }[] = [
    { id: 'emotional', name: 'Emotional Intelligence', short: 'EI', icon: Brain, accent: 'text-violet-600 bg-violet-50', lines: ['Behavioral • Conflict', 'Leadership • Teamwork'] },
    { id: 'clinical', name: 'Clinical', short: 'Clinical', icon: Stethoscope, accent: 'text-sky-600 bg-sky-50', lines: ['Scenarios • Pharmacology', 'Hemodynamics • ICU'] },
    { id: 'mixed', name: 'Mixed', short: 'Mixed', icon: Shuffle, accent: 'text-emerald-600 bg-emerald-50', lines: ['Clinical + EI', 'Combined practice'] },
    { id: 'custom', name: 'Custom', short: 'Custom', icon: SlidersHorizontal, accent: 'text-amber-600 bg-amber-50', lines: ['Build your own', 'custom interview'] },
  ]

  // Benefit copy describes what these modes actually do: Practice Mode scores a
  // whole scenario once its follow-ups are done, not every individual reply.
  const interviewModes: { id: InterviewMode, name: string, icon: LucideIcon, benefits: string[] }[] = [
    { id: 'practice', name: 'Practice Mode', icon: GraduationCap, benefits: ['Feedback after each scenario', 'Detailed scoring breakdown', 'Elite answer comparison'] },
    { id: 'real', name: 'Real Interview', icon: Target, benefits: ['No scores until the end', 'Adaptive follow-up questions', 'Full performance report afterward'] },
  ]

  const activeType = interviewTypes.find(t => t.id === interviewType)
  const setupStep = !interviewType ? 2 : 3
  const startLabel = interviewMode === 'real' ? 'Begin Real Interview' : 'Start Practice Interview'
  const recentSessions = interviewHistory.slice(0, 5)

  /** Score only exists on sessions saved after the engine columns were added. */
  const sessionScore = (session: any): number | null => {
    const direct = session?.overall_score
    if (typeof direct === 'number') return direct
    const fromState = session?.engine_state?.finalReport?.overall_score
    return typeof fromState === 'number' ? fromState : null
  }

  const formatSessionDate = (iso: string) => {
    const date = new Date(iso)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (date.toDateString() === today.toDateString()) return 'Today'
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  const typeBadgeClass = (typeId: string) => {
    switch (typeId) {
      case 'clinical': return 'bg-sky-50 text-sky-700'
      case 'emotional': return 'bg-violet-50 text-violet-700'
      case 'mixed': return 'bg-emerald-50 text-emerald-700'
      default: return 'bg-amber-50 text-amber-700'
    }
  }

  const openSessionInHistory = (sessionRowId: string) => {
    setShowFullHistory(true)
    setExpandedSession(sessionRowId)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        // Profile and interview history don't depend on each other, so they
        // run in parallel instead of one after another.
        const [profileResult] = await Promise.all([
          supabase.from('user_profiles').select('subscription_tier, interview_count').eq('id', user.id).single(),
          loadInterviewHistory(user.id),
        ])
        if (profileResult.data) {
          setUserTier(profileResult.data.subscription_tier || 'free')
          setInterviewCount(profileResult.data.interview_count || 0)
        }
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

  /**
   * Takes the messages and state explicitly rather than reading them from the
   * closure — a deferred save used to persist the previous turn's transcript.
   */
  const saveSession = async (
    convo: ChatMessage[],
    state: InterviewState | null,
    sessionRowId: string | null
  ) => {
    if (!userId || convo.length === 0) return sessionRowId

    const base: Record<string, any> = {
      user_id: userId,
      school_type: interviewType,
      interview_type: customTopic || interviewType,
      conversation: convo,
      question_count: state?.primaryQuestionNumber ?? 0,
      reviewed: false,
    }

    const extended: Record<string, any> = {
      ...base,
      mode: state?.mode ?? interviewMode,
      engine_state: state,
      overall_score: state?.finalReport?.overall_score ?? null,
      readiness: state?.finalReport?.readiness ?? null,
    }

    const write = async (payload: Record<string, any>) => {
      if (sessionRowId) {
        return supabase.from('interview_sessions').update(payload).eq('id', sessionRowId)
      }
      return supabase.from('interview_sessions').insert(payload).select().single()
    }

    let result = extendedColumnsAvailable ? await write(extended) : await write(base)
    if (result.error && extendedColumnsAvailable) {
      // The engine columns haven't been migrated in yet — fall back permanently.
      extendedColumnsAvailable = false
      result = await write(base)
    }

    let nextRowId = sessionRowId
    if (!sessionRowId && (result as any).data?.id) {
      nextRowId = (result as any).data.id
      setCurrentSessionId(nextRowId)
    }

    if (userId) await loadInterviewHistory(userId)
    return nextRowId
  }

  const markAsReviewed = async (sessionRowId: string) => {
    await supabase
      .from('interview_sessions')
      .update({ reviewed: true })
      .eq('id', sessionRowId)

    if (userId) await loadInterviewHistory(userId)
  }

  const loadRecentQuestions = async (type: string) => {
    if (!userId) return []
    const thirtySixHoursAgo = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('user_asked_questions')
      .select('question')
      .eq('user_id', userId)
      .eq('interview_type', type)
      .gte('asked_at', thirtySixHoursAgo)
      .order('asked_at', { ascending: false })
      .limit(20)
    return data?.map(d => d.question) || []
  }

  const saveQuestion = async (question: string, type: string) => {
    if (!userId || !question) return
    await supabase.from('user_asked_questions').insert({
      user_id: userId,
      interview_type: type,
      question: question
    })
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

  const recognitionRef = useRef<any>(null)
  /** Finalized dictation for the CURRENT answer only, never earlier ones. */
  const dictationBaseRef = useRef('')

  const resetDictationBuffer = (seed = '') => {
    dictationBaseRef.current = seed.trim() ? `${seed.trim()} ` : ''
  }

  /** Detaches handlers before aborting so a dying session can't fire callbacks. */
  const teardownRecognition = () => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (!recognition) return
    recognition.onresult = null
    recognition.onstart = null
    recognition.onend = null
    recognition.onerror = null
    // abort() discards pending audio; stop() would still emit a final result.
    try { recognition.abort() } catch {}
  }

  const stopDictation = () => {
    teardownRecognition()
    setIsListening(false)
  }

  const createRecognition = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return null

    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => setIsListening(true)
    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)

    // Walk only from resultIndex, accumulating finalized text into our own
    // buffer. Reading the list from 0 each time re-appended earlier utterances.
    recognition.onresult = (event: any) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript || ''
        if (result.isFinal) dictationBaseRef.current += `${text} `
        else interim += text
      }
      // The buffer keeps its own trailing space so words never glue together;
      // only what the applicant sees and sends gets trimmed.
      setInput(`${dictationBaseRef.current}${interim}`.replace(/\s+/g, ' ').trim())
    }

    return recognition
  }

  const startDictation = (seed = '') => {
    const recognition = createRecognition()
    if (!recognition) return false
    resetDictationBuffer(seed)
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      return false
    }
    return true
  }

  const toggleDictation = () => {
    if (isListening) {
      stopDictation()
      return
    }
    // Anything already typed stays put and dictation continues from there.
    if (!startDictation(input)) {
      alert('Speech recognition is not supported in this browser. Try Chrome.')
    }
  }

  /**
   * Every answer gets its own recognition session.
   *
   * Chrome can finalize an utterance AFTER the answer is sent and re-deliver it
   * at resultIndex 0 — which pasted the previous answer straight back into the
   * box, re-transcribed and slightly reworded. Skipping already-seen indexes
   * cannot fix that, because the index itself rewinds. A brand-new session
   * starts with an empty results list, so there is nothing to re-deliver.
   */
  const restartDictationForNextAnswer = () => {
    if (!recognitionRef.current) {
      resetDictationBuffer()
      return
    }
    // isListening is deliberately left alone: handlers are detached before the
    // abort, so the mic indicator never flickers across the handover.
    teardownRecognition()
    startDictation()
  }

  // Never leave the microphone running after the page goes away.
  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current
      recognitionRef.current = null
      if (recognition) {
        recognition.onresult = null
        recognition.onstart = null
        recognition.onend = null
        recognition.onerror = null
        try { recognition.abort() } catch {}
      }
    }
  }, [])

  /**
   * Builds the transcript entry from what the server cleared for display.
   * Falls back to the plain-text composition when `render` is absent, which
   * covers degraded turns and any client holding an older response shape.
   */
  const toAssistantMessage = (render: TurnRender | undefined, fallback: string): ChatMessage => {
    if (!render) return { role: 'assistant', content: fallback }
    return {
      role: 'assistant',
      content: render.spoken || fallback,
      evaluation: render.evaluation,
      withheldReviews: render.withheldReviews,
      finalReport: render.finalReport,
      allEvaluations: render.allEvaluations,
    }
  }

  /** Single place that talks to the engine, so both turn paths stay in sync. */
  const requestTurn = async (
    convo: {role: string, content: string}[],
    state: InterviewState | null,
    recent: string[]
  ): Promise<InterviewTurnResponse> => {
    const response = await fetch('/api/interview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: convo,
        state,
        recentQuestions: recent,
        mode: interviewMode,
        type: interviewType,
        customTopic,
      }),
    })
    return response.json()
  }

  const startInterview = async () => {
    if (!canInterview || !interviewType) return
    if (interviewType === 'custom' && !customTopic.trim()) { alert('Please enter a custom topic'); return }

    const recent = await loadRecentQuestions(interviewType)
    setRecentQuestions(recent)

    setStarted(true)
    setLoading(true)
    setTurnError('')
    setMessages([])
    setEngineState(null)
    setInterviewEnded(false)
    setSessionId(Date.now().toString(36) + Math.random().toString(36).substring(2))
    setCurrentSessionId(null)

    try {
      const data = await requestTurn([], null, recent)
      if (!data?.state) {
        // Nothing was consumed and nothing was saved — drop straight back to setup.
        setStarted(false)
        setTurnError(data?.message || 'Could not start the interview. Please try again.')
        setLoading(false)
        return
      }

      const convo = [toAssistantMessage(data.render, data.message)]
      setMessages(convo)
      setEngineState(data.state)
      // Only charge the free interview once the interview actually started.
      if (!isUltimate && userId) {
        await supabase.from('user_profiles').update({ interview_count: interviewCount + 1 }).eq('id', userId)
        setInterviewCount(interviewCount + 1)
      }
      if (data.turnKind === 'primary') await saveQuestion(data.questionAsked, interviewType)
      await saveSession(convo, data.state, null)
    } catch (error) {
      setStarted(false)
      setTurnError('Interview service temporarily unavailable. Please try again.')
    }
    setLoading(false)
  }

  const sendMessage = async () => {
    if (!input.trim() || loading || interviewEnded) return
    const answer = input
    const previousMessages = messages
    const newMessages = [...messages, { role: 'user', content: answer }]
    setMessages(newMessages)
    setInput('')
    restartDictationForNextAnswer()
    setTurnError('')
    setLoading(true)

    // A failed turn rolls the transcript back and hands the answer back to the
    // applicant, so a retry doesn't leave an error line for the model to read.
    const rollback = (notice: string) => {
      setMessages(previousMessages)
      setInput(answer)
      resetDictationBuffer(answer)
      setTurnError(notice)
    }

    try {
      const data = await requestTurn(newMessages, engineState, recentQuestions)
      if (!data?.state) {
        rollback(data?.message || 'Something went wrong. Send your answer again.')
        setLoading(false)
        return
      }

      const updatedMessages = [...newMessages, toAssistantMessage(data.render, data.message)]
      setMessages(updatedMessages)
      setEngineState(data.state)
      // Follow-ups deliberately aren't logged — the anti-repetition list
      // tracks primary scenarios only.
      if (data.turnKind === 'primary') await saveQuestion(data.questionAsked, interviewType)
      await saveSession(updatedMessages, data.state, currentSessionId)
      if (data.complete) {
        setInterviewEnded(true)
        stopDictation()
      }
    } catch (error) {
      rollback('Connection problem. Send your answer again.')
    }
    setLoading(false)
  }

  const resetInterview = () => {
    stopDictation()
    resetDictationBuffer()
    setStarted(false)
    setMessages([])
    setInterviewType('')
    setCustomTopic('')
    setInterviewEnded(false)
    setEngineState(null)
    setTurnError('')
    setRecentQuestions([])
    setSessionId('')
    setCurrentSessionId(null)
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <div className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:pl-20' : 'lg:pl-64'} pt-16 lg:pt-0`}>
        <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-10">

          {!isLoggedIn && (
            <div className="mb-6 flex justify-end">
              <Link
                href="/login"
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
              >
                Login
              </Link>
            </div>
          )}

          {/* Hero */}
          <header className="mb-8 flex flex-col gap-10 lg:mb-10 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-600">AI Mock Interview</p>
              <h1 className="mt-3 text-[32px] font-bold leading-[1.15] tracking-tight text-slate-900 sm:text-[38px] lg:text-[42px]">
                Prepare like the interview is tomorrow.
              </h1>
              <p className="mt-4 text-[15px] leading-relaxed text-slate-500 sm:text-base">
                Practice realistic CRNA interview questions with adaptive follow-ups, scoring, and detailed feedback.
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                {isLoggedIn && isUltimate && (
                  <>
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="h-4 w-4 text-violet-600" />
                      Ultimate
                    </span>
                    <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block" />
                    <span className="text-slate-500">Unlimited Interviews</span>
                  </>
                )}
                {isLoggedIn && !isUltimate && (
                  <>
                    <span className="text-slate-500">Free plan</span>
                    <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block" />
                    <span className={interviewCount === 0 ? 'text-emerald-600' : 'text-slate-400'}>
                      {interviewCount === 0 ? '1 free interview available' : 'Free interview used'}
                    </span>
                    <Link href="/pricing" className="normal-case tracking-normal text-violet-600 underline-offset-2 hover:underline">
                      Upgrade for unlimited
                    </Link>
                  </>
                )}
                {!isLoggedIn && (
                  <span className="normal-case tracking-normal text-slate-500">
                    Sign up free to get 1 mock interview
                  </span>
                )}
              </div>
            </div>

            {/* Hero visual — decorative, desktop only */}
            <div className="hidden shrink-0 lg:block" aria-hidden="true">
              <div className="relative flex h-[210px] w-[300px] items-center justify-center">
                <div className="absolute inset-0 rounded-[28px] bg-gradient-to-br from-violet-200/50 via-violet-100/30 to-transparent blur-2xl" />
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 300 210" fill="none">
                  {[26, 46, 66, 234, 254, 274].map((x, i) => {
                    const h = [34, 62, 88, 88, 62, 34][i]
                    return (
                      <rect
                        key={x}
                        x={x}
                        y={105 - h / 2}
                        width="3"
                        height={h}
                        rx="1.5"
                        className="fill-violet-300/60"
                      />
                    )
                  })}
                </svg>
                <div className="relative flex h-28 w-28 items-center justify-center rounded-3xl border border-white/60 bg-white/70 shadow-xl shadow-violet-200/50 backdrop-blur">
                  <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-violet-500/10 to-indigo-500/5" />
                  <Mic className="relative h-12 w-12 text-violet-600" strokeWidth={1.75} />
                </div>
              </div>
            </div>
          </header>

          {!started ? (
            <>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                {/* Setup */}
                <section className="lg:col-span-8">
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
                    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <h2 className="text-[22px] font-bold tracking-tight text-slate-900 sm:text-2xl">
                        Set Up Your Interview
                      </h2>
                      <ol className="flex items-center gap-2 text-xs font-medium sm:gap-3">
                        {[
                          { n: '01', label: 'Mode' },
                          { n: '02', label: 'Interview Type' },
                          { n: '03', label: 'Start' },
                        ].map((step, i) => {
                          const index = i + 1
                          const active = index === setupStep
                          const done = index < setupStep
                          return (
                            <li key={step.n} className="flex items-center gap-2 sm:gap-3">
                              {i > 0 && <span className="h-1 w-1 rounded-full bg-slate-300" />}
                              <span
                                className={`flex items-center gap-1.5 ${
                                  active ? 'text-violet-600' : done ? 'text-slate-500' : 'text-slate-400'
                                }`}
                              >
                                <span
                                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                                    active
                                      ? 'bg-violet-600 text-white'
                                      : done
                                        ? 'bg-slate-200 text-slate-600'
                                        : 'bg-slate-100 text-slate-400'
                                  }`}
                                >
                                  {done ? <Check className="h-3 w-3" strokeWidth={3} /> : step.n}
                                </span>
                                <span className={`hidden sm:inline ${active ? 'font-semibold' : ''}`}>{step.label}</span>
                              </span>
                            </li>
                          )
                        })}
                      </ol>
                    </div>

                    {/* Mode */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {interviewModes.map((mode) => {
                        const Icon = mode.icon
                        const selected = interviewMode === mode.id
                        return (
                          <button
                            key={mode.id}
                            type="button"
                            onClick={() => setInterviewMode(mode.id)}
                            aria-pressed={selected}
                            className={`relative rounded-2xl border p-5 text-left transition ${
                              selected
                                ? 'border-violet-400 bg-violet-50/60 shadow-sm'
                                : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                            }`}
                          >
                            {selected && (
                              <span className="absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-full bg-violet-600">
                                <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                              </span>
                            )}
                            <span
                              className={`mb-4 flex h-12 w-12 items-center justify-center rounded-xl ${
                                selected ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              <Icon className="h-6 w-6" strokeWidth={1.75} />
                            </span>
                            <h3 className="text-lg font-bold tracking-tight text-slate-900">{mode.name}</h3>
                            <ul className="mt-3 space-y-2">
                              {mode.benefits.map((benefit) => (
                                <li key={benefit} className="flex items-start gap-2 text-[13px] leading-snug text-slate-600">
                                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" strokeWidth={3} />
                                  <span>{benefit}</span>
                                </li>
                              ))}
                            </ul>
                          </button>
                        )
                      })}
                    </div>

                    {/* Type */}
                    <h3 className="mb-4 mt-8 text-base font-semibold text-slate-900">Choose Interview Type</h3>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      {interviewTypes.map((type) => {
                        const Icon = type.icon
                        const selected = interviewType === type.id
                        return (
                          <button
                            key={type.id}
                            type="button"
                            onClick={() => setInterviewType(type.id)}
                            aria-pressed={selected}
                            className={`relative rounded-2xl border px-2.5 py-4 text-center transition ${
                              selected
                                ? 'border-violet-400 bg-violet-50/60 shadow-sm'
                                : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                            }`}
                          >
                            <span
                              className={`absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full border ${
                                selected ? 'border-violet-600 bg-violet-600' : 'border-slate-300 bg-white'
                              }`}
                            >
                              {selected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={4} />}
                            </span>
                            <span className={`mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl ${type.accent}`}>
                              <Icon className="h-[22px] w-[22px]" strokeWidth={1.75} />
                            </span>
                            <h4 className="text-[14px] font-semibold leading-tight text-slate-900 sm:text-[15px]">{type.name}</h4>
                            <p className="mt-2 text-[11px] leading-[1.6] text-slate-500">
                              {type.lines.map((line) => (
                                <span key={line} className="block">{line}</span>
                              ))}
                            </p>
                          </button>
                        )
                      })}
                    </div>

                    {interviewType === 'custom' && (
                      <div className="mt-5">
                        <label htmlFor="custom-topic" className="mb-2 block text-sm font-medium text-slate-700">
                          What should this interview focus on?
                        </label>
                        <input
                          id="custom-topic"
                          type="text"
                          value={customTopic}
                          onChange={(e) => setCustomTopic(e.target.value)}
                          placeholder="e.g., Leadership experience, handling difficult patients..."
                          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                        />
                      </div>
                    )}

                    {turnError && (
                      <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {turnError}
                      </div>
                    )}

                    {/* CTA */}
                    <div className="mt-7">
                      {!isLoggedIn ? (
                        <>
                          <Link
                            href="/login"
                            className="flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-500 text-base font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:from-violet-700 hover:to-indigo-600"
                          >
                            Sign Up Free to Start Interviewing
                            <ArrowRight className="h-5 w-5" />
                          </Link>
                          <p className="mt-3 text-center text-sm text-slate-500">
                            Get 1 free interview. Upgrade to Ultimate for unlimited.
                          </p>
                        </>
                      ) : canInterview ? (
                        <button
                          onClick={startInterview}
                          disabled={!interviewType || (interviewType === 'custom' && !customTopic.trim()) || loading}
                          className="flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-500 text-base font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:from-violet-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                        >
                          {loading ? 'Starting…' : startLabel}
                          {!loading && <ArrowRight className="h-5 w-5" />}
                        </button>
                      ) : (
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center">
                          <p className="text-sm font-medium text-slate-700">You have used your free interview.</p>
                          <Link
                            href="/pricing"
                            className="mt-4 inline-flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-500 px-6 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:from-violet-700 hover:to-indigo-600"
                          >
                            Upgrade to Ultimate for unlimited interviews
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        </div>
                      )}

                      <p className="mt-4 flex items-center justify-center gap-2 text-[13px] text-slate-400">
                        <ShieldCheck className="h-4 w-4" />
                        Your interviews are private to your account
                      </p>
                    </div>
                  </div>
                </section>

                {/* History */}
                <aside className="lg:col-span-4">
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
                    <div className="mb-5 flex items-center justify-between gap-3">
                      <h2 className="text-lg font-bold tracking-tight text-slate-900">Past Interview Review</h2>
                      {interviewHistory.length > 0 && (
                        <button
                          onClick={() => setShowFullHistory(!showFullHistory)}
                          className="text-sm font-semibold text-violet-600 transition hover:text-violet-700"
                        >
                          {showFullHistory ? 'Hide' : 'View All'}
                        </button>
                      )}
                    </div>

                    {!isLoggedIn ? (
                      <p className="py-8 text-center text-sm text-slate-400">
                        Sign in to see your past interviews.
                      </p>
                    ) : interviewHistory.length === 0 ? (
                      <div className="py-8 text-center">
                        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100">
                          <History className="h-5 w-5 text-slate-400" />
                        </span>
                        <p className="text-sm text-slate-500">No interviews yet.</p>
                        <p className="mt-1 text-xs text-slate-400">Your results will appear here.</p>
                      </div>
                    ) : (
                      <>
                        <div className="-mx-1 overflow-x-auto">
                          <table className="w-full min-w-[300px] border-collapse text-left">
                            <thead>
                              <tr className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                <th className="px-1 pb-2 font-semibold">Interview</th>
                                <th className="px-1 pb-2 font-semibold">Type</th>
                                <th className="px-1 pb-2 text-right font-semibold">Score</th>
                                <th className="px-1 pb-2 text-right font-semibold">Date</th>
                                <th className="w-4" />
                              </tr>
                            </thead>
                            <tbody>
                              {recentSessions.map((session) => {
                                const score = sessionScore(session)
                                const typeMeta = interviewTypes.find(t => t.id === session.school_type)
                                return (
                                  <tr
                                    key={session.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openSessionInHistory(session.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        openSessionInHistory(session.id)
                                      }
                                    }}
                                    className="cursor-pointer border-t border-slate-100 transition hover:bg-slate-50"
                                  >
                                    <td className="px-1 py-3 text-[13px] font-medium text-slate-700">
                                      {session.mode === 'real' ? 'Real Interview' : 'Practice Interview'}
                                    </td>
                                    <td className="px-1 py-3">
                                      <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ${typeBadgeClass(session.school_type)}`}>
                                        {typeMeta?.short || session.school_type}
                                      </span>
                                    </td>
                                    <td className="px-1 py-3 text-right text-[13px] font-bold tabular-nums text-slate-900">
                                      {score !== null ? (Number.isInteger(score) ? score : score.toFixed(1)) : '—'}
                                    </td>
                                    <td className="px-1 py-3 text-right text-[13px] text-slate-500">
                                      {formatSessionDate(session.created_at)}
                                    </td>
                                    <td className="py-3 pl-1 text-slate-300">
                                      <ChevronRight className="h-4 w-4" />
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>

                        <button
                          onClick={() => setShowFullHistory(!showFullHistory)}
                          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                        >
                          <History className="h-4 w-4 text-violet-600" />
                          {showFullHistory ? 'Hide Full Interview History' : 'View Full Interview History'}
                        </button>
                      </>
                    )}
                  </div>
                </aside>
              </div>

              {/* Full history: existing filters + expandable transcripts */}
              {showFullHistory && isLoggedIn && interviewHistory.length > 0 && (
                <div className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
                  <h2 className="mb-5 text-xl font-bold tracking-tight text-slate-900">Full Interview History</h2>

                  <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Interview Type</label>
                      <select
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="all">All Types</option>
                        <option value="emotional">Emotional Intelligence</option>
                        <option value="clinical">Clinical</option>
                        <option value="mixed">Mixed</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Mode</label>
                      <select
                        value={filterMode}
                        onChange={(e) => setFilterMode(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="all">All Modes</option>
                        <option value="practice">Practice</option>
                        <option value="real">Real Interview</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Review Status</label>
                      <select
                        value={filterReviewed}
                        onChange={(e) => setFilterReviewed(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="all">All</option>
                        <option value="needs_review">Needs Review</option>
                        <option value="reviewed">Reviewed</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Sort By</label>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {(() => {
                      let filtered = interviewHistory

                      if (filterType !== 'all') {
                        filtered = filtered.filter(s => s.school_type === filterType)
                      }

                      if (filterMode !== 'all') {
                        // Sessions predating modes are practice-style interviews.
                        filtered = filtered.filter(s => (s.mode || 'practice') === filterMode)
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
                        return <p className="py-8 text-center text-sm text-slate-400">No interviews match your filters</p>
                      }

                      return filtered.map((session) => {
                        const score = sessionScore(session)
                        const typeMeta = interviewTypes.find(t => t.id === session.school_type)
                        return (
                          <div key={session.id} className="overflow-hidden rounded-2xl border border-slate-200">
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => setExpandedSession(expandedSession === session.id ? null : session.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setExpandedSession(expandedSession === session.id ? null : session.id)
                                }
                              }}
                              className="flex cursor-pointer items-center justify-between gap-3 p-4 transition hover:bg-slate-50"
                            >
                              <div className="min-w-0 text-left">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="text-sm font-semibold text-slate-900">
                                    {typeMeta?.name || session.school_type}
                                    {session.interview_type !== session.school_type && ` — ${session.interview_type}`}
                                  </h3>
                                  <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${typeBadgeClass(session.school_type)}`}>
                                    {session.mode === 'real' ? 'Real Interview' : 'Practice'}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-slate-500">
                                  {new Date(session.created_at).toLocaleDateString()} • {session.question_count} questions
                                  {score !== null && ` • ${Number.isInteger(score) ? score : score.toFixed(1)}/10`}
                                  {session.readiness && ` • ${session.readiness}`}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    markAsReviewed(session.id)
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                                    session.reviewed
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                                  }`}
                                >
                                  {session.reviewed ? 'Reviewed' : 'Review'}
                                </button>
                                <ChevronRight
                                  className={`h-4 w-4 text-slate-400 transition ${expandedSession === session.id ? 'rotate-90' : ''}`}
                                />
                              </div>
                            </div>

                            {expandedSession === session.id && (
                              <div className="max-h-[32rem] space-y-3 overflow-y-auto border-t border-slate-200 bg-slate-50 p-4">
                                {(session.conversation || []).map((msg: ChatMessage, msgIdx: number) => (
                                  <InterviewMessage key={msgIdx} message={msg} />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              )}

              {/* Feedback widget */}
              <button
                onClick={() => setShowFeedbackWidget(!showFeedbackWidget)}
                className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-white shadow-xl shadow-violet-500/30 transition hover:bg-violet-700"
                title="Report an issue or share feedback"
              >
                <MessageSquare className="h-5 w-5" />
              </button>

              {showFeedbackWidget && (
                <div className="fixed bottom-24 right-6 z-40 w-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900">Help Us Improve</h3>
                    <button onClick={() => setShowFeedbackWidget(false)} className="text-slate-400 transition hover:text-slate-600">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mb-3 text-xs text-slate-500">Experiencing issues with the AI interview? Let me know!</p>

                  {feedbackSent ? (
                    <div className="py-4 text-center">
                      <span className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50">
                        <Check className="h-4 w-4 text-emerald-600" strokeWidth={3} />
                      </span>
                      <p className="text-sm font-semibold text-emerald-600">Thank you!</p>
                      <p className="text-xs text-slate-500">Your feedback has been received.</p>
                      <button onClick={() => setFeedbackSent(false)} className="mt-3 text-xs text-violet-600 underline">
                        Send another
                      </button>
                    </div>
                  ) : (
                    <>
                      <textarea
                        value={feedbackMessage}
                        onChange={(e) => setFeedbackMessage(e.target.value)}
                        placeholder="Describe any issues, bugs, or suggestions..."
                        rows={3}
                        className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      />
                      <button
                        onClick={submitFeedback}
                        disabled={!feedbackMessage.trim() || sendingFeedback}
                        className="mt-2 w-full rounded-xl bg-violet-600 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {sendingFeedback ? 'Sending...' : 'Send Feedback'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            /* Live interview */
            <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="flex flex-col gap-2 border-b border-slate-100 bg-gradient-to-r from-violet-600 to-indigo-500 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="flex items-center gap-2.5">
                  {activeType && <activeType.icon className="h-[18px] w-[18px] text-white/90" strokeWidth={1.75} />}
                  <span className="text-sm font-semibold text-white sm:text-base">{activeType?.name} Interview</span>
                  <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white/90">
                    {interviewMode === 'real' ? 'Real Interview' : 'Practice'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {onFollowUp && (
                    <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white/90">
                      Follow-up
                    </span>
                  )}
                  <span className="text-xs font-medium text-white/80 sm:text-sm">
                    Question {questionNumber} of {maxQuestions}
                  </span>
                  <button
                    onClick={resetInterview}
                    className="flex items-center gap-1 text-xs text-white/80 transition hover:text-white sm:text-sm"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Start Over
                  </button>
                </div>
              </div>

              <div className="h-[26rem] space-y-3 overflow-y-auto p-4 sm:h-[32rem] sm:space-y-4 sm:p-6">
                {messages.map((msg, index) => (
                  <InterviewMessage key={index} message={msg} />
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-500">Thinking…</div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-100 p-3 sm:p-4">
                {!interviewEnded ? (
                  <>
                    <div className="flex gap-2 sm:gap-3">
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                        placeholder={isListening ? 'Listening…' : 'Type your answer, or use the mic…'}
                        className={`flex-1 rounded-xl border px-4 py-3 text-sm outline-none transition sm:text-base ${
                          isListening
                            ? 'border-red-400 bg-red-50'
                            : 'border-slate-200 focus:border-violet-400 focus:ring-2 focus:ring-violet-100'
                        }`}
                      />
                      <button
                        onClick={toggleDictation}
                        aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
                        className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl transition ${
                          isListening
                            ? 'animate-pulse bg-red-500 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        <Mic className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        onClick={sendMessage}
                        disabled={loading}
                        className="flex h-[46px] shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-500 px-5 text-sm font-semibold text-white transition hover:from-violet-700 hover:to-indigo-600 disabled:opacity-50"
                      >
                        <Send className="h-4 w-4" />
                        <span className="hidden sm:inline">Send</span>
                      </button>
                    </div>
                    {turnError && <p className="mt-2 text-xs text-red-600 sm:text-sm">{turnError}</p>}
                  </>
                ) : (
                  <div className="text-center">
                    <p className="mb-4 text-sm font-medium text-slate-700 sm:text-base">Interview complete</p>
                    {isUltimate ? (
                      <button
                        onClick={resetInterview}
                        className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-500 px-6 py-3 text-sm font-semibold text-white transition hover:from-violet-700 hover:to-indigo-600"
                      >
                        Start New Interview
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    ) : (
                      <Link
                        href="/pricing"
                        className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-500 px-6 py-3 text-sm font-semibold text-white transition hover:from-violet-700 hover:to-indigo-600"
                      >
                        Upgrade for More Interviews
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    )}
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
