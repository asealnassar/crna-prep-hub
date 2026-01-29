'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'

export default function Interview() {
  const [started, setStarted] = useState(false)
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [interviewType, setInterviewType] = useState('behavioral')
  const [customTopic, setCustomTopic] = useState('')
const [questionCount, setQuestionCount] = useState(0)
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<any>(null)

  const startListening = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Speech recognition is not supported in your browser. Please use Chrome.')
      return
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    recognitionRef.current = new SpeechRecognition()
    recognitionRef.current.continuous = true
    recognitionRef.current.interimResults = true

   recognitionRef.current.onresult = (event: any) => {
  let transcript = ''
  for (let i = 0; i < event.results.length; i++) {
    transcript += event.results[i][0].transcript
  }
  setInput(transcript)
}

    recognitionRef.current.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setIsListening(false)
    }

    recognitionRef.current.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current.start()
    setIsListening(true)
  }

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    setIsListening(false)
  }

  const startInterview = async () => {
    setStarted(true)
    setLoading(true)
    
    let systemMessage = ''
    
    if (interviewType === 'behavioral') {
      systemMessage = "You are a CRNA program interviewer conducting a behavioral interview. Ask one question at a time. Start with an introduction and your first behavioral question. Be professional but friendly. After the candidate answers, provide brief feedback and ask the next question. Focus on questions about teamwork, stress management, critical thinking, and patient care experiences."
    } else if (interviewType === 'clinical') {
      systemMessage = "You are a CRNA program interviewer conducting a clinical interview. Ask one question at a time. Start with an introduction and your first clinical question. Test the candidate's knowledge of anesthesia concepts, pharmacology, anatomy, and physiology. After they answer, provide feedback on accuracy and ask the next question."
    } else if (interviewType === 'mixed') {
      systemMessage = "You are a CRNA program interviewer conducting a mixed interview with both behavioral and clinical questions. Ask one question at a time. Alternate between behavioral questions (teamwork, leadership, stress) and clinical questions (pharmacology, anatomy, anesthesia concepts). Provide brief feedback after each answer."
    } else if (interviewType === 'custom') {
      systemMessage = "You are a CRNA program interviewer conducting a focused interview. The candidate wants to practice questions about: " + customTopic + ". Ask one question at a time, subtly incorporating the requested topics into your questions. Start with an introduction, then ask questions that naturally weave in the specified topics. After they answer, provide feedback and ask the next question."
    }

    try {
      const response = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Please start the interview.' }],
          systemMessage
        })
      })
      
      const data = await response.json()
      setMessages([{ role: 'assistant', content: data.message }])
setQuestionCount(1)
    } catch (error) {
      setMessages([{ role: 'assistant', content: "Welcome! I'm your CRNA interview coach. Let's begin with your first question: Tell me about yourself and why you want to become a CRNA?" }])
    }
    setLoading(false)
  }

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    
    const newMessages = [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const response = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          systemMessage: "You are a CRNA program interviewer. Continue the interview based on the conversation. Provide feedback on the candidate's answer, then ask the next interview question. Be encouraging but honest."
        })
      })
      
      const data = await response.json()
      const newCount = questionCount + 1
setQuestionCount(newCount)
if (newCount >= 7) {
  setMessages([...newMessages, { role: 'assistant', content: data.message + "\n\nThat concludes our interview! You've completed all 7 questions. Great job practicing! Click 'Start Over' to begin a new session." }])
} else {
  setMessages([...newMessages, { role: 'assistant', content: data.message }])
}
    } catch (error) {
      setMessages([...newMessages, { role: 'assistant', content: 'Great answer! Let me ask you another question: How do you handle stressful situations in the ICU?' }])
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <Link href="/"><h1 className="text-2xl font-bold text-blue-600">CRNA Prep Hub</h1></Link>
            <div className="flex gap-4">
              <Link href="/dashboard" className="text-gray-700 hover:text-blue-600">Dashboard</Link>
              <Link href="/schools" className="text-gray-700 hover:text-blue-600">Schools</Link>
              <Link href="/interview" className="text-blue-600 font-semibold">Mock Interview</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold mb-2">AI Mock Interview</h1>
        <p className="text-gray-600 mb-8">Practice your CRNA interview skills with our AI interviewer</p>

        {!started ? (
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-xl font-bold mb-4">Choose Interview Type</h2>
            
            <div className="space-y-4 mb-6">
              <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="type"
                  value="behavioral"
                  checked={interviewType === 'behavioral'}
                  onChange={(e) => setInterviewType(e.target.value)}
                  className="mr-3"
                />
                <div>
                  <p className="font-semibold">Behavioral Interview</p>
                  <p className="text-sm text-gray-600">Questions about teamwork, leadership, stress management</p>
                </div>
              </label>

              <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="type"
                  value="clinical"
                  checked={interviewType === 'clinical'}
                  onChange={(e) => setInterviewType(e.target.value)}
                  className="mr-3"
                />
                <div>
                  <p className="font-semibold">Clinical Interview</p>
                  <p className="text-sm text-gray-600">Questions about pharmacology, anatomy, anesthesia concepts</p>
                </div>
              </label>

              <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="type"
                  value="mixed"
                  checked={interviewType === 'mixed'}
                  onChange={(e) => setInterviewType(e.target.value)}
                  className="mr-3"
                />
                <div>
                  <p className="font-semibold">Mixed Interview</p>
                  <p className="text-sm text-gray-600">Combination of behavioral and clinical questions</p>
                </div>
              </label>

              <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="type"
                  value="custom"
                  checked={interviewType === 'custom'}
                  onChange={(e) => setInterviewType(e.target.value)}
                  className="mr-3"
                />
                <div>
                  <p className="font-semibold">Custom Interview</p>
                  <p className="text-sm text-gray-600">Request specific topics you want to practice</p>
                </div>
              </label>

              {interviewType === 'custom' && (
                <div className="p-4 border rounded-lg bg-gray-50">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    What topics do you want to focus on?
                  </label>
                  <textarea
                    value={customTopic}
                    onChange={(e) => setCustomTopic(e.target.value)}
                    placeholder="e.g., Questions about vasopressors, hemodynamic management, pharmacology of neuromuscular blockers..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg h-24"
                  />
                </div>
              )}
            </div>

            <button
              onClick={startInterview}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700"
            >
              Start Interview
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="h-96 overflow-y-auto mb-4 space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`p-4 rounded-lg ${msg.role === 'assistant' ? 'bg-blue-50' : 'bg-gray-100 ml-8'}`}>
                  <p className="text-sm font-semibold mb-1">{msg.role === 'assistant' ? 'Interviewer' : 'You'}</p>
                  <p>{msg.content}</p>
                </div>
              ))}
<div className="text-sm text-gray-500 text-right">Question {questionCount} of 7</div>
              {loading && <div className="text-gray-500">Interviewer is thinking...</div>}
            </div>

            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Type or use the mic button..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg"
              />
              <button
                onClick={isListening ? stopListening : startListening}
                className={`px-4 py-2 rounded-lg font-semibold ${isListening ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
              >
                {isListening ? '🔴 Stop' : '🎤 Speak'}
              </button>
              <button
                onClick={sendMessage}
                disabled={loading}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>

            {isListening && <p className="text-red-500 text-sm mb-2">🎤 Listening... Speak now, then click Stop when done.</p>}

            <button
              onClick={() => { setStarted(false); setMessages([]); setQuestionCount(0) }}
              className="mt-4 text-gray-600 hover:text-gray-800"
            >
              ← Start Over
            </button>
          </div>
        )}
      </div>
    </div>
  )
}