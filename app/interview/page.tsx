'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

export default function Interview() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const [userTier, setUserTier] = useState('free')
  const [interviewCount, setInterviewCount] = useState(0)
  const [userId, setUserId] = useState<string | null>(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [interviewType, setInterviewType] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [questionCount, setQuestionCount] = useState(0)
  const [interviewEnded, setInterviewEnded] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'
  const canInterview = isUltimate || interviewCount < 1
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
      
      if (!user) {
        router.push('/login')
        return
      }

      setUserId(user.id)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier, interview_count')
        .eq('id', user.id)
        .single()

      if (profile) {
        setUserTier(profile.subscription_tier || 'free')
        setInterviewCount(profile.interview_count || 0)
      }

      setPageLoading(false)
    }

    init()
  }, [])

  const getSystemMessage = () => {
    const randomSeed = Math.random().toString(36).substring(7)
    
    let basePrompt = `You are an experienced CRNA program interviewer conducting a mock interview. 
    Be professional but friendly. Ask one question at a time.
    After the candidate answers, provide brief constructive feedback (2-3 sentences) and then ask the next question.
    Keep responses concise and helpful.
    
    IMPORTANT: Generate unique, varied questions each time. Do NOT repeat questions. Use this random seed to vary your questions: ${randomSeed}
    
    This is question ${questionCount + 1} of ${maxQuestions}. When you reach question ${maxQuestions}, after their answer, provide final overall feedback summarizing their strengths and areas to improve, then say "This concludes our interview. Good luck with your CRNA applications!"`

    switch (interviewType) {
      case 'emotional':
        return basePrompt + `
        
        Focus on Emotional Intelligence and behavioral questions that real CRNA programs ask.
        
        Draw from topics like: self-awareness, empathy, stress management, conflict resolution, teamwork, communication, leadership, adaptability, receiving feedback, handling failure, work-life balance, motivation, professionalism, ethical dilemmas, and interpersonal relationships.
        
        Ask questions in varied formats: "Tell me about a time...", "How would you handle...", "Describe a situation where...", "What would you do if...", "Give an example of..."
        
        Make each question unique and realistic to what CRNA admissions committees actually ask. Vary the scenarios and contexts.`
        
      case 'clinical':
        return basePrompt + `
        
        Ask deep, focused clinical knowledge questions that CRNA school admissions committees ask. Keep questions simple and direct - NO complex patient scenarios.
        
        Ask about ONE specific topic at a time such as:
        - Vasopressors: mechanism of action, receptor activity, when to use phenylephrine vs ephedrine vs norepinephrine
        - Sedation: differences between propofol, etomidate, ketamine, midazolam
        - Neuromuscular blockers: depolarizing vs non-depolarizing, succinylcholine contraindications, reversal agents
        - Opioids: differences between fentanyl, morphine, hydromorphone, remifentanil
        - Inhalation agents: MAC values, which agent for which situation
        - Airway: Mallampati classification, predictors of difficult airway
        - Monitoring: what does each number on the monitor tell you
        - Physiology: cardiac output, preload, afterload, oxygen delivery
        - Local anesthetics: amides vs esters, LAST symptoms and treatment
        
        Question format should be simple and direct like:
        "What receptors does epinephrine act on?"
        "What is the mechanism of action of rocuronium?"
        "Why would you choose etomidate over propofol?"
        "What are the contraindications for succinylcholine?"
        "Explain the difference between fentanyl and remifentanil."
        
        Do NOT create complex multi-part scenarios. One clear question at a time.`
        
      case 'mixed':
        return basePrompt + `
        
        Ask a balanced MIX of Emotional Intelligence and Clinical questions, alternating between them.
        
        For Emotional Intelligence: Draw from self-awareness, empathy, stress management, conflict resolution, teamwork, communication, leadership, handling failure, and ethical dilemmas.
        
        For Clinical: Draw from pharmacology, physiology, airway management, hemodynamics, anesthesia complications, patient assessment, and emergency scenarios.
        
        Make each question unique and varied. Do not follow a predictable pattern. These should reflect real CRNA program interview questions.`
        
      case 'custom':
        return basePrompt + `
        
        Focus the interview on this specific topic: ${customTopic}
        
        Generate unique, thoughtful questions related to this topic that would help someone prepare for a CRNA program interview. Vary the question format and specific scenarios. Ask questions that an admissions committee might realistically ask about this topic.`
        
      default:
        return basePrompt
    }
  }

  const startInterview = async () => {
    if (!canInterview || !interviewType) return
    if (interviewType === 'custom' && !customTopic.trim()) {
      alert('Please enter a custom topic')
      return
    }
    
    setStarted(true)
    setLoading(true)
    setQuestionCount(1)

    // Increment interview count for non-ultimate users
    if (!isUltimate && userId) {
      await supabase
        .from('user_profiles')
        .update({ interview_count: interviewCount + 1 })
        .eq('id', userId)
      
      setInterviewCount(interviewCount + 1)
    }

    try {
      const response = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Please start the mock interview with your first question.' }],
          systemMessage: getSystemMessage()
        })
      })

      const data = await response.json()
      setMessages([{ role: 'assistant', content: data.message }])
    } catch (error) {
      setMessages([{ role: 'assistant', content: 'Welcome! Let\'s begin your mock interview. Tell me, why do you want to become a CRNA?' }])
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

    if (newQuestionCount > maxQuestions) {
      setMessages([...newMessages, { role: 'assistant', content: 'This concludes our interview. Thank you for practicing with CRNA Prep Hub! Review your responses and keep preparing. Good luck with your CRNA applications! 🎉' }])
      setInterviewEnded(true)
      setLoading(false)
      return
    }

    try {
      const response = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          systemMessage: getSystemMessage()
        })
      })

      const data = await response.json()
      setMessages([...newMessages, { role: 'assistant', content: data.message }])
      
      if (data.message.includes('concludes our interview')) {
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
  }

  if (pageLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
            <div className="flex gap-6">
              <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white font-semibold">Mock Interview</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">AI Mock Interview</h1>
          <p className="text-indigo-200">Practice your CRNA interview skills with our AI interviewer</p>
          
          {!isUltimate && (
            <div className="mt-4 inline-block bg-yellow-500/20 border border-yellow-500/50 rounded-lg px-4 py-2">
              <p className="text-yellow-200 text-sm">
                {interviewCount === 0 
                  ? '🎁 You have 1 free interview available!' 
                  : '🔒 You have used your free interview. Upgrade to Ultimate for unlimited interviews!'}
              </p>
            </div>
          )}
          
          {isUltimate && (
            <div className="mt-4 inline-block bg-green-500/20 border border-green-500/50 rounded-lg px-4 py-2">
              <p className="text-green-200 text-sm">✨ Ultimate Plan - Unlimited Interviews</p>
            </div>
          )}
        </div>

        {!started ? (
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <div className="w-20 h-20 bg-gradient-to-br from-purple-600 to-pink-500 rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="text-4xl">🎤</span>
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Choose Interview Type</h2>
              <p className="text-gray-600">Select the type of interview you want to practice (10 questions max)</p>
            </div>

            {canInterview ? (
              <>
                <div className="grid md:grid-cols-2 gap-4 mb-6">
                  {interviewTypes.map((type) => (
                    <button
                      key={type.id}
                      onClick={() => setInterviewType(type.id)}
                      className={`p-4 rounded-xl border-2 text-left transition ${
                        interviewType === type.id
                          ? 'border-purple-500 bg-purple-50'
                          : 'border-gray-200 hover:border-purple-300'
                      }`}
                    >
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-2xl">{type.icon}</span>
                        <h3 className="font-semibold text-gray-800">{type.name}</h3>
                      </div>
                      <p className="text-sm text-gray-600">{type.description}</p>
                    </button>
                  ))}
                </div>

                {interviewType === 'custom' && (
                  <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Enter your custom topic:</label>
                    <input
                      type="text"
                      value={customTopic}
                      onChange={(e) => setCustomTopic(e.target.value)}
                      placeholder="e.g., Leadership experience, Handling difficult patients..."
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                )}

                <button
                  onClick={startInterview}
                  disabled={!interviewType || (interviewType === 'custom' && !customTopic.trim())}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Start Interview
                </button>
              </>
            ) : (
              <div className="text-center">
                <button
                  disabled
                  className="px-8 py-4 bg-gray-400 text-white font-semibold rounded-xl cursor-not-allowed text-lg mb-4"
                >
                  🔒 Interview Used
                </button>
                <p className="text-gray-600 mb-4">You've used your free interview.</p>
                <Link 
                  href="/pricing"
                  className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
                >
                  Upgrade to Ultimate for Unlimited Interviews
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="bg-gradient-to-r from-purple-600 to-pink-500 px-6 py-3 flex justify-between items-center">
              <span className="text-white font-medium">
                {interviewTypes.find(t => t.id === interviewType)?.name} Interview
              </span>
              <div className="flex items-center gap-4">
                <span className="text-white/80 text-sm">
                  Question {Math.min(questionCount, maxQuestions)} of {maxQuestions}
                </span>
                <button
                  onClick={resetInterview}
                  className="text-white/80 hover:text-white text-sm underline transition"
                >
                  Start Over
                </button>
              </div>
            </div>

            <div className="h-96 overflow-y-auto p-6 space-y-4">
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-xs md:max-w-md px-4 py-3 rounded-2xl ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-purple-600 to-pink-500 text-white'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 text-gray-800 px-4 py-3 rounded-2xl">
                    Thinking...
                  </div>
                </div>
              )}
            </div>

            <div className="border-t p-4">
           {!interviewEnded ? (
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                    placeholder={isListening ? "Listening..." : "Type or click 🎤 to speak..."}
                    className={`flex-1 px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${isListening ? 'border-red-500 bg-red-50' : 'border-gray-300'}`}
                  />
                  <button
                    onClick={() => {
                      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
                        alert('Speech recognition not supported in this browser. Try Chrome.')
                        return
                      }
                      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
                      const recognition = new SpeechRecognition()
                      recognition.continuous = false
                      recognition.interimResults = false
                      recognition.lang = 'en-US'
                      
                      recognition.onstart = () => setIsListening(true)
                      recognition.onend = () => setIsListening(false)
                      recognition.onerror = () => setIsListening(false)
                      recognition.onresult = (event: any) => {
                        const transcript = event.results[0][0].transcript
                        setInput(prev => prev + ' ' + transcript)
                      }
                      
                      if (isListening) {
                        recognition.stop()
                      } else {
                        recognition.start()
                      }
                    }}
                    className={`px-4 py-3 rounded-xl font-semibold transition ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}
                  >
                    🎤
                  </button>
                  <button
                    onClick={sendMessage}
                    disabled={loading}
                    className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-gray-600 mb-4">Interview complete! 🎉</p>
                  {isUltimate && (
                    <button
                      onClick={resetInterview}
                      className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
                    >
                      Start New Interview
                    </button>
                  )}
                  {!isUltimate && (
                    <Link 
                      href="/pricing"
                      className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
                    >
                      Upgrade for More Interviews
                    </Link>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}