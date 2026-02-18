'use client'

import { useState, useEffect, useRef } from 'react'
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
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [pageLoading, setPageLoading] = useState(true)
  const [interviewType, setInterviewType] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [questionCount, setQuestionCount] = useState(0)
  const [interviewEnded, setInterviewEnded] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [askedQuestions, setAskedQuestions] = useState<string[]>([])
  const [sessionId, setSessionId] = useState('')
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
      }
      setPageLoading(false)
    }
    init()
  }, [])

  const getSystemMessage = () => {
    const randomSeed = Math.random().toString(36).substring(7) + Date.now()
    const questionPool = Math.floor(Math.random() * 100)

    const avoidList = askedQuestions.length > 0
      ? `\n\nCRITICAL - DO NOT ASK ANY OF THESE QUESTIONS AGAIN (you already asked them):\n${askedQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n')}\n\nYou MUST ask a COMPLETELY DIFFERENT question that is NOT similar to any of the above. Pick a different category and different topic.`
      : ''

    let basePrompt = `You are an experienced CRNA program interviewer conducting a mock interview. Be professional but friendly. Ask one question at a time. After the candidate answers, provide brief constructive feedback (2-3 sentences) and then ask the next question. Keep responses concise and helpful.

CRITICAL INSTRUCTIONS FOR VARIETY:
- Session ID: ${sessionId} | Random seed: ${randomSeed} | Question pool: ${questionPool}
- This is question ${questionCount + 1} of ${maxQuestions}.
- You MUST pick a DIFFERENT category and topic for each question.
- NEVER ask the same question twice, even reworded.
- NEVER start with "Why do you want to be a CRNA" unless it hasn't been asked yet.
${avoidList}

When you reach question ${maxQuestions}, after their answer, provide final overall feedback summarizing their strengths and areas to improve, then say "This concludes our interview. Good luck with your CRNA applications!"`

    switch (interviewType) {
      case 'emotional':
        return basePrompt + `

Focus on Emotional Intelligence and behavioral questions that real CRNA programs ask. You MUST rotate through ALL of these categories evenly. Do NOT favor any single category.

CATEGORY 1 - STRESS & PRESSURE (pick ONE you haven't used):
- "Describe the most stressful situation you've faced."
- "How do you handle high-pressure situations?"
- "How do you decompress after a difficult shift?"
- "What does stress management look like for you?"
- "Tell me about a time you felt overwhelmed at work."
- "How do you perform when stakes are highest?"

CATEGORY 2 - CONFLICT & DISAGREEMENT (pick ONE you haven't used):
- "Tell me about a conflict with a physician or coworker."
- "Describe a time you disagreed with a provider."
- "How do you handle interpersonal conflict in a team setting?"
- "Tell me about a time you had to stand your ground."
- "How do you approach a conversation when you disagree with a superior?"
- "Describe a time when two team members disagreed and you had to mediate."

CATEGORY 3 - MISTAKES & ACCOUNTABILITY (pick ONE you haven't used):
- "Tell me about a mistake or near miss."
- "Describe a time you were wrong."
- "How do you handle making errors in patient care?"
- "What did you learn from your biggest professional failure?"
- "Tell me about a time you had to own up to something."
- "How do you recover after making a clinical error?"

CATEGORY 4 - FEEDBACK & GROWTH (pick ONE you haven't used):
- "Tell me about a time you received negative feedback."
- "How do you handle criticism?"
- "Describe a time feedback changed the way you practice."
- "How do you stay open to learning?"
- "What's the hardest feedback you've ever received?"
- "How do you seek out constructive criticism?"

CATEGORY 5 - PATIENT & FAMILY INTERACTIONS (pick ONE you haven't used):
- "Describe a difficult patient or family interaction."
- "How do you communicate in emotional moments?"
- "Tell me about a time you advocated for a patient."
- "Describe a time you spoke up when something didn't feel right."
- "How do you deliver bad news to a patient's family?"
- "Tell me about a time you went above and beyond for a patient."

CATEGORY 6 - MOTIVATION & FIT (pick ONE you haven't used):
- "Why do you want to be a CRNA?"
- "Why should we accept you into our program over others in the waiting room?"
- "What makes you a strong candidate for this program?"
- "Where do you see yourself 5 years after graduating?"
- "What drew you to anesthesia specifically?"
- "What will you bring to our cohort that others can't?"

CATEGORY 7 - PRACTICAL & LIFESTYLE (pick ONE you haven't used):
- "How will you support yourself financially during CRNA school?"
- "How will you balance school, clinical, and personal life?"
- "What is your support system like?"
- "What sacrifices are you prepared to make?"
- "How have you prepared for the rigors of this program?"
- "What is your backup plan if things get tough?"

CATEGORY 8 - LEADERSHIP & TEAMWORK (pick ONE you haven't used):
- "Describe a time you took a leadership role."
- "Tell me about a time you worked with a difficult team."
- "How do you contribute to a positive team environment?"
- "What does professionalism mean to you?"
- "Tell me about a time you mentored someone."
- "How do you handle a team member who isn't pulling their weight?"

CATEGORY 9 - ETHICS & CRITICAL THINKING (pick ONE you haven't used):
- "Describe an ethical dilemma you faced in healthcare."
- "How do you handle a situation where you feel a treatment is not in the patient's best interest?"
- "What would you do if you saw a colleague cutting corners?"
- "How do you approach end-of-life care discussions?"
- "Tell me about a time your values were tested at work."
- "What would you do if a patient refused a recommended treatment?"

CATEGORY 10 - SELF-AWARENESS & PERSONAL (pick ONE you haven't used):
- "What is your biggest weakness?"
- "How has your ICU experience prepared you for CRNA school?"
- "What is something you're actively working to improve?"
- "How would your coworkers describe you?"
- "What has been the defining moment of your nursing career?"
- "What scares you most about becoming a CRNA?"

Use question pool number ${questionPool} to decide which category to start with. Rotate to a NEW category each question. NEVER repeat a category until all have been used.`

      case 'clinical':
        return basePrompt + ` Ask deep, focused clinical knowledge questions that CRNA school admissions committees ask. Keep questions simple and direct - NO complex multi-part scenarios. Ask about ONE specific topic at a time.

        RESPIRATORY & AIRWAY:
        - ABGs: interpretation, compensation, mixed disorders, expected values
        - Rapid Sequence Induction (RSI): indications, steps, drug choices, cricoid pressure
        - Hypoxia troubleshooting: causes of desaturation, differential diagnosis, interventions
        - End-tidal CO2 (EtCO2) interpretation: waveform analysis, causes of changes, clinical significance
        - Difficult airway management: predictors, ASA algorithm, backup plans, supraglottic devices, surgical airway
        - Mallampati classification, airway assessment
        - ARDS: pathophysiology, ventilator management, lung protective strategies, PEEP

        CARDIAC & HEMODYNAMICS:
        - Hypotension after induction: causes, prevention, treatment
        - Shock types: hypovolemic, cardiogenic, distributive - recognition and management
        - SVR, Preload, Afterload, Contractility: definitions, relationships, clinical applications
        - Arrhythmia recognition: common dysrhythmias, ACLS protocols, treatment
        - Effects of anesthetics on BP and HR: which agents cause hypotension, tachycardia, bradycardia
        - Cardiac output and its determinants

        PHARMACOLOGY:
        - Induction agents: propofol (mechanism, side effects), etomidate (adrenal suppression), ketamine (dissociative, sympathomimetic)
        - Opioids: fentanyl, morphine, hydromorphone, remifentanil - differences, potency, side effects
        - Benzodiazepines: midazolam, mechanism, reversal with flumazenil
        - Vasopressors vs Inotropes: phenylephrine vs ephedrine vs norepinephrine vs epinephrine vs vasopressin vs dobutamine - when to use each
        - Neuromuscular blockers: depolarizing vs non-depolarizing, succinylcholine contraindications, reversal agents
        - Local anesthetics: amides vs esters, LAST symptoms and treatment
        - Inhalation agents: MAC values, which agent for which situation

        CRITICAL CARE SCENARIOS:
        - Vasopressor escalation: when to add agents, titration strategies
        - Weaning sedation: readiness criteria, protocols, complications
        - Septic shock management: early goal-directed therapy, fluid resuscitation, vasopressor choice
        - Lactate and shock: significance of elevated lactate, trending, clearance
        - Malignant hyperthermia: triggers, recognition, dantrolene treatment

        Question format should be simple and direct like:
        "What does an ABG of pH 7.28, PaCO2 55, HCO3 24 tell you?"
        "Walk me through your RSI protocol."
        "A patient desaturates to 85% after intubation. What are your next steps?"
        "What is the difference between vasopressors and inotropes?"
        "Your patient becomes hypotensive after propofol induction. What do you do?"
        "How do you differentiate between types of shock?"
        "What does a sudden drop in EtCO2 indicate?"
        "When would you choose ketamine over propofol for induction?"
        "Your septic patient is on max norepinephrine. What do you add next?"

        Vary between all categories. One clear question at a time.`

      case 'mixed':
        return basePrompt + ` Ask a balanced MIX of Emotional Intelligence and Clinical questions, alternating between them. For Emotional Intelligence: Draw from stress and pressure, conflict and disagreement, mistakes and accountability, feedback and growth, patient interactions, motivation and fit, practical and lifestyle questions, leadership, ethics, and self-awareness. For Clinical: Draw from respiratory and airway (ABGs, RSI, hypoxia, EtCO2, difficult airway, ARDS), cardiac and hemodynamics (hypotension after induction, shock types, SVR/preload/afterload/contractility, arrhythmias, anesthetic effects on vitals), pharmacology (induction agents, opioids, benzos, vasopressors vs inotropes, neuromuscular blockers, local anesthetics), and critical care scenarios (vasopressor escalation, weaning sedation, septic shock, lactate). Make each question unique and varied. Do not follow a predictable pattern.`

      case 'custom':
        return basePrompt + ` Focus the interview on this specific topic: ${customTopic} Generate unique, thoughtful questions related to this topic that would help someone prepare for a CRNA program interview.`

      default:
        return basePrompt
    }
  }

  const startInterview = async () => {
    if (!canInterview || !interviewType) return
    if (interviewType === 'custom' && !customTopic.trim()) { alert('Please enter a custom topic'); return }
    setStarted(true)
    setLoading(true)
    setQuestionCount(1)
    setAskedQuestions([])
    setSessionId(Date.now().toString(36) + Math.random().toString(36).substring(2))
    if (!isUltimate && userId) {
      await supabase.from('user_profiles').update({ interview_count: interviewCount + 1 }).eq('id', userId)
      setInterviewCount(interviewCount + 1)
    }
    try {
      const response = await fetch('/api/interview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Please start the mock interview with your first question. Pick a random category to start with - do NOT start with "Why do you want to be a CRNA".' }], systemMessage: getSystemMessage() }) })
      const data = await response.json()
      setMessages([{ role: 'assistant', content: data.message }])
      setAskedQuestions([data.message.split('?')[0] + '?'])
    } catch (error) {
      setMessages([{ role: 'assistant', content: 'Welcome! Let\'s begin your mock interview. Describe the most stressful situation you have faced in your nursing career and how you handled it.' }])
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
      const response = await fetch('/api/interview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: newMessages, systemMessage: getSystemMessage() }) })
      const data = await response.json()
      setMessages([...newMessages, { role: 'assistant', content: data.message }])
      setAskedQuestions(prev => [...prev, data.message.split('?')[0] + '?'])
      if (data.message.includes('concludes our interview')) { setInterviewEnded(true) }
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
    setSessionId('')
  }

  if (pageLoading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800"><div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-3 text-center"><a href="/interview-prep" className="text-black font-semibold hover:underline">🚀 NEW: School-Specific Interview Style is NOW LIVE for Ultimate members →</a></div>
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4"><Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link><Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">Sponsors</Link></div>
            <div className="flex gap-6">
              {isLoggedIn && <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>}
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white font-semibold">Mock Interview</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
              <Link href="/sponsors" className="text-white/80 hover:text-white transition">Sponsors</Link>
              {isLoggedIn && userEmail === 'asealnassar@gmail.com' && (<Link href="/admin/schools" className="text-yellow-400 hover:text-yellow-300 transition">Admin</Link>)}
              {!isLoggedIn && (<Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition">Login</Link>)}
            </div>
          </div>
        </div>
      </nav>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">AI Mock Interview</h1>
          <p className="text-indigo-200">Practice your CRNA interview skills with our AI interviewer</p>
          {isLoggedIn && !isUltimate && (
            <div className="mt-4 inline-block bg-yellow-500/20 border border-yellow-500/50 rounded-lg px-4 py-2">
              <p className="text-yellow-200 text-sm">{interviewCount === 0 ? '🎁 You have 1 free interview available!' : '🔒 You have used your free interview. Upgrade to Ultimate for unlimited interviews!'}</p>
            </div>
          )}
          {isLoggedIn && isUltimate && (
            <div className="mt-4 inline-block bg-green-500/20 border border-green-500/50 rounded-lg px-4 py-2">
              <p className="text-green-200 text-sm">✨ Ultimate Plan - Unlimited Interviews</p>
            </div>
          )}
          {!isLoggedIn && (
            <div className="mt-4 inline-block bg-purple-500/20 border border-purple-500/50 rounded-lg px-4 py-2">
              <p className="text-purple-200 text-sm">🎁 Sign up free to get 1 free mock interview! Ultimate members get unlimited.</p>
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
            <div className="grid md:grid-cols-2 gap-4 mb-6">
              {interviewTypes.map((type) => (
                <button key={type.id} onClick={() => setInterviewType(type.id)} className={`p-4 rounded-xl border-2 text-left transition ${interviewType === type.id ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-purple-300'}`}>
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
                <input type="text" value={customTopic} onChange={(e) => setCustomTopic(e.target.value)} placeholder="e.g., Leadership experience, Handling difficult patients..." className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500" />
              </div>
            )}
            {!isLoggedIn ? (
              <div className="text-center">
                <Link href="/login" className="inline-block w-full py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-lg text-center">Sign Up Free to Start Interviewing</Link>
                <p className="text-gray-500 text-sm mt-3">Get 1 free interview. Upgrade to Ultimate for unlimited.</p>
              </div>
            ) : canInterview ? (
              <button onClick={startInterview} disabled={!interviewType || (interviewType === 'custom' && !customTopic.trim())} className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-lg disabled:opacity-50 disabled:cursor-not-allowed">Start Interview</button>
            ) : (
              <div className="text-center">
                <button disabled className="px-8 py-4 bg-gray-400 text-white font-semibold rounded-xl cursor-not-allowed text-lg mb-4">🔒 Interview Used</button>
                <p className="text-gray-600 mb-4">You have used your free interview.</p>
                <Link href="/pricing" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Upgrade to Ultimate for Unlimited Interviews</Link>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-purple-600 to-pink-500 px-6 py-3 flex justify-between items-center">
              <span className="text-white font-medium">{interviewTypes.find(t => t.id === interviewType)?.name} Interview</span>
              <div className="flex items-center gap-4">
                <span className="text-white/80 text-sm">Question {Math.min(questionCount, maxQuestions)} of {maxQuestions}</span>
                <button onClick={resetInterview} className="text-white/80 hover:text-white text-sm underline transition">Start Over</button>
              </div>
            </div>
            <div className="h-96 overflow-y-auto p-6 space-y-4">
              {messages.map((msg, index) => (
                <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-xs md:max-w-md px-4 py-3 rounded-2xl ${msg.role === 'user' ? 'bg-gradient-to-r from-purple-600 to-pink-500 text-white' : 'bg-gray-100 text-gray-800'}`}>{msg.content}</div>
                </div>
              ))}
              {loading && (<div className="flex justify-start"><div className="bg-gray-100 text-gray-800 px-4 py-3 rounded-2xl">Thinking...</div></div>)}
            </div>
            <div className="border-t p-4">
              {!interviewEnded ? (
                <div className="flex gap-3">
                  <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendMessage()} placeholder={isListening ? "Listening..." : "Type or click mic to speak..."} className={`flex-1 px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${isListening ? 'border-red-500 bg-red-50' : 'border-gray-300'}`} />
                  <button onClick={() => { if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) { alert('Speech recognition not supported. Try Chrome.'); return } const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; const recognition = new SR(); recognition.continuous = false; recognition.interimResults = false; recognition.lang = 'en-US'; recognition.onstart = () => setIsListening(true); recognition.onend = () => setIsListening(false); recognition.onerror = () => setIsListening(false); recognition.onresult = (event: any) => { setInput(prev => prev + ' ' + event.results[0][0].transcript) }; if (isListening) { recognition.stop() } else { recognition.start() } }} className={`px-4 py-3 rounded-xl font-semibold transition ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}>🎤</button>
                  <button onClick={sendMessage} disabled={loading} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50">Send</button>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-gray-600 mb-4">Interview complete! 🎉</p>
                  {isUltimate && (<button onClick={resetInterview} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Start New Interview</button>)}
                  {!isUltimate && (<Link href="/pricing" className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Upgrade for More Interviews</Link>)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
