'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import Link from 'next/link'

export default function PersonalStatementAnalyzer() {
  const [statement, setStatement] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const [analysis, setAnalysis] = useState<any>(null)
  const [rewritten, setRewritten] = useState('')
  const [userTier, setUserTier] = useState('free')
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setIsLoggedIn(true)
      setUserEmail(user.email || '')
      const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
      if (profile) setUserTier(profile.subscription_tier || 'free')
    }
    init()
  }, [])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      setStatement(text)
    }
    reader.readAsText(file)
  }

  const analyzeStatement = async () => {
    if (!statement.trim() || statement.length < 100) {
      alert('Please paste a statement (at least 100 characters)')
      return
    }

    setAnalyzing(true)
    setAnalysis(null)

    try {
      const res = await fetch('/api/analyze-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement, userTier })
      })

      const data = await res.json()
      if (data.error) {
        alert(data.error)
      } else {
        setAnalysis(data.analysis)
      }
    } catch (error) {
      alert('Analysis failed. Please try again.')
    } finally {
      setAnalyzing(false)
    }
  }

const rewriteStatement = async () => {
    if (!isUltimate) {
      alert('Rewrite feature is only available for Ultimate members')
      return
    }

    if (!analysis) {
      alert('Please analyze your statement first before rewriting')
      return
    }

    setRewriting(true)
    try {
      const res = await fetch('/api/analyze-statement', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement, userTier, analysis })
      })

      const data = await res.json()
      if (data.error) {
        alert(data.error)
      } else {
        setRewritten(data.rewritten)
      }
    } catch (error) {
      alert('Rewrite failed. Please try again.')
    } finally {
      setRewriting(false)
    }
  }
  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600 bg-green-50'
    if (score >= 60) return 'text-yellow-600 bg-yellow-50'
    return 'text-red-600 bg-red-50'
  }

  const getCategoryScoreColor = (score: number) => {
    if (score >= 8) return 'text-green-600 bg-green-50'
    if (score >= 6) return 'text-yellow-600 bg-yellow-50'
    return 'text-red-600 bg-red-50'
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar isLoggedIn={isLoggedIn} userEmail={userEmail} isAdmin={userEmail === 'asealnassar@gmail.com'} onCollapsedChange={setSidebarCollapsed} />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Personal Statement Analyzer</h1>
            <p className="text-indigo-200">Get AI-powered feedback on your CRNA personal statement</p>
          </div>

          {/* Tier Badge */}
          <div className="mb-6">
            {isUltimate ? (
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white rounded-full text-sm font-semibold">
                <span>⭐</span> Ultimate Access - Full Analysis + Rewrites
              </div>
            ) : (
              <div className="bg-yellow-100 border border-yellow-300 rounded-xl p-4">
                <p className="text-sm text-yellow-800">
                  <strong>Free Tier:</strong> Basic score and limited feedback. 
                  <Link href="/pricing" className="underline ml-1">Upgrade to Ultimate</Link> for full breakdown, sentence-level edits, and AI rewrites.
                </p>
              </div>
            )}
          </div>

          {/* Input Section */}
          <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Your Personal Statement</h2>
            
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Upload Document (.txt)
              </label>
              <input 
                type="file" 
                accept=".txt"
                onChange={handleFileUpload}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Or Paste Your Statement</label>
              <textarea
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                placeholder="Paste your personal statement here (minimum 100 characters)..."
                rows={12}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-2">{statement.length} characters</p>
            </div>

            <button
              onClick={analyzeStatement}
              disabled={analyzing || statement.length < 100}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {analyzing ? 'Analyzing...' : 'Analyze My Statement'}
            </button>
          </div>

          {/* Results Section */}
          {analysis && (
            <div className="space-y-6">
              
              {/* Overall Score */}
              <div className="bg-white rounded-2xl shadow-xl p-6">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Overall Score</h2>
                <div className="flex items-center gap-4">
                  <div className={`text-6xl font-bold ${getScoreColor(analysis.overallScore)} rounded-2xl px-6 py-4`}>
                    {analysis.overallScore}%
                  </div>
                  <div className="flex-1">
                    <div className="w-full bg-gray-200 rounded-full h-4">
                      <div 
                        className="bg-gradient-to-r from-purple-600 to-pink-500 h-4 rounded-full transition-all duration-500"
                        style={{ width: `${analysis.overallScore}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Category Breakdown */}
              <div className="bg-white rounded-2xl shadow-xl p-6">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Category Breakdown</h2>
                <div className="space-y-4">
                  {analysis.categories?.map((cat: any, idx: number) => (
                    <div key={idx} className="border-b pb-4 last:border-b-0">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold text-gray-800">{cat.name}</h3>
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${getCategoryScoreColor(cat.score)}`}>
                          {cat.score}/10
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mb-2">{cat.feedback}</p>
                      {isUltimate && (
                        <p className="text-sm text-purple-700 bg-purple-50 p-3 rounded-lg">
                          <strong>Suggestion:</strong> {cat.suggestion}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Admissions Impression */}
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-3">Admissions Committee Impression</h2>
                <p className="text-gray-700">{analysis.admissionsImpression}</p>
              </div>

              {/* Weaknesses */}
              <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-3">Biggest Weaknesses</h2>
                <ul className="space-y-2">
                  {analysis.biggestWeaknesses?.map((weakness: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2 text-gray-700">
                      <span className="text-red-500 font-bold">•</span>
                      <span>{weakness}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Top Changes */}
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-3">Top 3 Changes to Improve Acceptance</h2>
                <ol className="space-y-2">
                  {analysis.topChanges?.map((change: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2 text-gray-700">
                      <span className="text-green-600 font-bold">{idx + 1}.</span>
                      <span>{change}</span>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Sentence Analysis (Ultimate Only) */}
              {isUltimate && analysis.sentenceAnalysis && (
                <div className="bg-white rounded-2xl shadow-xl p-6">
                  <h2 className="text-2xl font-bold text-gray-800 mb-4">Sentence-Level Feedback</h2>
                  <div className="space-y-4">
                    {analysis.sentenceAnalysis.map((item: any, idx: number) => (
                      <div key={idx} className="border-l-4 pl-4 py-2" style={{
                        borderColor: item.label === 'Strong' ? '#10b981' : item.label === 'Weak' ? '#ef4444' : '#f59e0b'
                      }}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`px-2 py-1 rounded text-xs font-bold ${
                            item.label === 'Strong' ? 'bg-green-100 text-green-700' :
                            item.label === 'Weak' ? 'bg-red-100 text-red-700' :
                            'bg-yellow-100 text-yellow-700'
                          }`}>
                            {item.label}
                          </span>
                        </div>
                        <p className="text-sm text-gray-600 mb-2 italic">"{item.original}"</p>
                        <p className="text-sm text-gray-800"><strong>Improved:</strong> "{item.improved}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Rewrite Button */}
              {isUltimate && (
                <div className="bg-white rounded-2xl shadow-xl p-6">
                  <h2 className="text-2xl font-bold text-gray-800 mb-4">AI Rewrite</h2>
                  <button
                    onClick={rewriteStatement}
                    disabled={rewriting}
                    className="w-full py-3 bg-gradient-to-r from-green-600 to-emerald-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
                  >
                    {rewriting ? 'Rewriting...' : '✨ Rewrite My Entire Statement'}
                  </button>
                  
                  {rewritten && (
                    <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl">
                      <h3 className="font-semibold text-green-800 mb-2">Improved Version:</h3>
                      <p className="text-sm text-gray-700 whitespace-pre-line">{rewritten}</p>
                      <button
                        onClick={() => navigator.clipboard.writeText(rewritten)}
                        className="mt-3 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition"
                      >
                        📋 Copy to Clipboard
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!isUltimate && (
                <div className="bg-gradient-to-r from-purple-100 to-pink-100 border border-purple-300 rounded-2xl p-6 text-center">
                  <h3 className="text-xl font-bold text-purple-800 mb-2">Want More?</h3>
                  <p className="text-purple-700 mb-4">Upgrade to Ultimate for sentence-level edits, AI rewrites, and detailed suggestions</p>
                  <Link href="/pricing" className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">
                    Upgrade to Ultimate
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
