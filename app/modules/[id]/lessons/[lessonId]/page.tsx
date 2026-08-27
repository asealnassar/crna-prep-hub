'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { MODULES_ENABLED } from '@/lib/featureFlags'
import Sidebar from '@/components/Sidebar'
import LessonContentRenderer from '@/components/LessonContentRenderer'

export default function LessonPage() {
  const params = useParams()
  const router = useRouter()
  const moduleId = params?.id as string
  const lessonId = params?.lessonId as string

  const [module, setModule] = useState<any>(null)
  const [lesson, setLesson] = useState<any>(null)
  const [allLessons, setAllLessons] = useState<any[]>([])
  const [questions, setQuestions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [viewMode, setViewMode] = useState<'text' | 'video'>('text')

  // Quiz state
  const [quizStarted, setQuizStarted] = useState(false)
  const [answers, setAnswers] = useState<{[qId: string]: string}>({})
  const [submitted, setSubmitted] = useState(false)
  const [score, setScore] = useState(0)
  const [alreadyPassed, setAlreadyPassed] = useState(false)
  const [saving, setSaving] = useState(false)

  const supabase = createClient()

  if (!MODULES_ENABLED && typeof window !== 'undefined') {
    window.location.href = '/dashboard'
  }
  const PASS_THRESHOLD = 0.8

  useEffect(() => {
    const init = async () => {
      const { data: lessonData } = await supabase
        .from('lessons')
        .select('*')
        .eq('id', lessonId)
        .single()
      setLesson(lessonData)

      const { data: moduleData } = await supabase
        .from('modules')
        .select('*')
        .eq('id', moduleId)
        .single()
      setModule(moduleData)

      const { data: lessonsData } = await supabase
        .from('lessons')
        .select('id, title, order_index')
        .eq('module_id', moduleId)
        .order('order_index')
      setAllLessons(lessonsData || [])

      const { data: questionsData } = await supabase
        .from('quiz_questions')
        .select('*')
        .eq('lesson_id', lessonId)
        .order('order_index')
      setQuestions(questionsData || [])

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        setIsAdmin(user.email === 'asealnassar@gmail.com')

        const { data: existingProgress } = await supabase
          .from('user_lesson_progress')
          .select('*')
          .eq('user_id', user.id)
          .eq('lesson_id', lessonId)
          .maybeSingle()

        if (existingProgress?.passed) {
          setAlreadyPassed(true)
        }
      }
      setLoading(false)
    }
    if (lessonId && moduleId) init()
  }, [lessonId, moduleId])

  const selectAnswer = (questionId: string, optionId: string) => {
    if (submitted) return
    setAnswers(prev => ({ ...prev, [questionId]: optionId }))
  }

  const submitQuiz = async () => {
    if (Object.keys(answers).length < questions.length) {
      alert('Please answer all questions before submitting.')
      return
    }

    let correctCount = 0
    questions.forEach(q => {
      if (answers[q.id] === q.correct_option_id) correctCount++
    })

    const finalScore = correctCount
    const total = questions.length
    const passed = (finalScore / total) >= PASS_THRESHOLD

    setScore(finalScore)
    setSubmitted(true)
    setSaving(true)

    if (userId) {
      await supabase.from('user_lesson_progress').upsert({
        user_id: userId,
        lesson_id: lessonId,
        quiz_score: finalScore,
        quiz_total: total,
        passed: passed,
        completed_at: new Date().toISOString()
      }, { onConflict: 'user_id,lesson_id' })

      if (passed) setAlreadyPassed(true)
    }
    setSaving(false)
  }

  const retakeQuiz = () => {
    setAnswers({})
    setSubmitted(false)
    setScore(0)
    setQuizStarted(true)
  }

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4 text-center">
          <p className="text-indigo-200 mb-6">Please log in to access this lesson.</p>
          <Link href="/login" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  if (!lesson) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-4">Lesson not found</p>
          <Link href={`/modules/${moduleId}`} className="text-indigo-300 hover:text-white transition">← Back to Module</Link>
        </div>
      </div>
    )
  }

  const currentIndex = allLessons.findIndex(l => l.id === lessonId)
  const prevLesson = currentIndex > 0 ? allLessons[currentIndex - 1] : null
  const nextLesson = currentIndex < allLessons.length - 1 ? allLessons[currentIndex + 1] : null
  const passedCount = score
  const totalQuestions = questions.length
  const passedThisAttempt = submitted && (score / totalQuestions) >= PASS_THRESHOLD

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <Link href={`/modules/${moduleId}`} className="inline-flex items-center gap-2 text-indigo-300 hover:text-white transition mb-6 text-sm">
            ← Back to {module?.title || 'Module'}
          </Link>

          <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 mb-6">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">{lesson.title}</h1>
              {alreadyPassed && (
                <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full flex-shrink-0">✓ Completed</span>
              )}
            </div>

            {lesson.video_url && (
              <div className="flex gap-2 mb-6 bg-gray-100 rounded-xl p-1.5 w-fit">
                <button
                  onClick={() => setViewMode('text')}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${viewMode === 'text' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500'}`}
                >
                  📖 Text
                </button>
                <button
                  onClick={() => setViewMode('video')}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${viewMode === 'video' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500'}`}
                >
                  🎬 Video
                </button>
              </div>
            )}

            {viewMode === 'video' && lesson.video_url ? (
              <div className="aspect-video w-full rounded-xl overflow-hidden bg-black">
                <iframe
                  src={lesson.video_url}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
              </div>
            ) : (
              <LessonContentRenderer content={lesson.content} />
            )}
          </div>

          {/* Quiz Section */}
          {questions.length > 0 && (
            <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 mb-6">
              {!quizStarted && !alreadyPassed ? (
                <div className="text-center py-6">
                  <div className="text-4xl mb-3">📝</div>
                  <h2 className="text-lg sm:text-xl font-bold text-gray-800 mb-2">Ready for the quiz?</h2>
                  <p className="text-gray-500 text-sm mb-6">{questions.length} questions · Need 80% to pass</p>
                  <button
                    onClick={() => setQuizStarted(true)}
                    className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
                  >
                    Start Quiz
                  </button>
                </div>
              ) : !quizStarted && alreadyPassed ? (
                <div className="text-center py-6">
                  <div className="text-4xl mb-3">✅</div>
                  <h2 className="text-lg sm:text-xl font-bold text-gray-800 mb-2">You\'ve already passed this quiz!</h2>
                  <button
                    onClick={() => setQuizStarted(true)}
                    className="text-purple-600 text-sm font-semibold hover:underline"
                  >
                    Retake anyway
                  </button>
                </div>
              ) : (
                <div>
                  <h2 className="text-lg sm:text-xl font-bold text-gray-800 mb-6">Quiz: {lesson.title}</h2>

                  {questions.map((q, qIndex) => {
                    const userAnswer = answers[q.id]
                    const isCorrect = userAnswer === q.correct_option_id
                    return (
                      <div key={q.id} className="mb-6 pb-6 border-b border-gray-100 last:border-0">
                        <p className="font-semibold text-gray-800 mb-3 text-sm sm:text-base">{qIndex + 1}. {q.question}</p>
                        <div className="space-y-2">
                          {q.options.map((opt: any) => {
                            let optClass = 'border-gray-200 hover:border-purple-300'
                            if (submitted) {
                              if (opt.id === q.correct_option_id) {
                                optClass = 'border-green-400 bg-green-50'
                              } else if (opt.id === userAnswer && !isCorrect) {
                                optClass = 'border-red-400 bg-red-50'
                              } else {
                                optClass = 'border-gray-200 opacity-60'
                              }
                            } else if (userAnswer === opt.id) {
                              optClass = 'border-purple-500 bg-purple-50'
                            }
                            return (
                              <button
                                key={opt.id}
                                onClick={() => selectAnswer(q.id, opt.id)}
                                disabled={submitted}
                                className={`w-full text-left px-4 py-3 border-2 rounded-xl text-sm sm:text-base transition ${optClass}`}
                              >
                                {opt.text}
                              </button>
                            )
                          })}
                        </div>

                        {submitted && q.explanation && (
                          <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl p-3 sm:p-4">
                            <p className="text-blue-900 text-xs sm:text-sm font-semibold mb-1">💡 Explanation</p>
                            <p className="text-blue-800 text-xs sm:text-sm leading-relaxed whitespace-pre-line">{q.explanation}</p>
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {!submitted ? (
                    <button
                      onClick={submitQuiz}
                      disabled={saving}
                      className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
                    >
                      {saving ? 'Submitting...' : 'Submit Quiz'}
                    </button>
                  ) : (
                    <div className={`text-center p-6 rounded-xl ${passedThisAttempt ? 'bg-green-50' : 'bg-orange-50'}`}>
                      <div className="text-3xl mb-2">{passedThisAttempt ? '🎉' : '📚'}</div>
                      <p className="font-bold text-lg mb-1" style={{ color: passedThisAttempt ? '#15803d' : '#c2410c' }}>
                        {passedCount} / {totalQuestions} correct
                      </p>
                      <p className="text-sm text-gray-600 mb-4">
                        {passedThisAttempt ? 'You passed! Great work.' : 'You need 80% to pass. Review the lesson and try again.'}
                      </p>
                      <button
                        onClick={retakeQuiz}
                        className="px-6 py-2.5 bg-white border border-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition text-sm"
                      >
                        {passedThisAttempt ? 'Retake Quiz' : 'Try Again'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between gap-3">
            {prevLesson ? (
              <Link href={`/modules/${moduleId}/lessons/${prevLesson.id}`} className="px-4 sm:px-5 py-2.5 sm:py-3 bg-white/10 text-white rounded-xl hover:bg-white/20 transition text-sm sm:text-base">
                ← Previous
              </Link>
            ) : <div></div>}
            {nextLesson ? (
              <Link href={`/modules/${moduleId}/lessons/${nextLesson.id}`} className="px-4 sm:px-5 py-2.5 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">
                Next Lesson →
              </Link>
            ) : (
              <Link href={`/modules/${moduleId}`} className="px-4 sm:px-5 py-2.5 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">
                Back to Module Overview
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
