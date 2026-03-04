'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import jsPDF from 'jspdf'

interface Course {
  id: string
  name: string
  grade: string
  credits: number
  year?: string
  term?: string
  categories: ('science' | 'nursing' | 'general')[]
  isTransfer?: boolean
}

const gradePoints: { [key: string]: number } = {
  'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'F': 0.0
}

export default function GPACalculator() {
  const [mode, setMode] = useState<'manual' | 'ai'>('manual')
  const [courses, setCourses] = useState<Course[]>([])
  const [uploading, setUploading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [savedCalculations, setSavedCalculations] = useState<any[]>([])
  const [calculationName, setCalculationName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
        if (profile) {
          setUserTier(profile.subscription_tier || 'free')
        }

        const { data: calcs } = await supabase
          .from('gpa_calculations')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
        if (calcs) setSavedCalculations(calcs)
      }
    }
    init()
  }, [])

  const addCourse = () => {
    setCourses([...courses, {
      id: Math.random().toString(),
      name: '',
      grade: 'A',
      credits: 3,
      year: '',
      term: '',
      categories: ['general'],
      isTransfer: false
    }])
  }

  const removeCourse = (id: string) => {
    setCourses(courses.filter(c => c.id !== id))
  }

  const updateCourse = (id: string, field: keyof Course, value: any) => {
    setCourses(courses.map(c => c.id === id ? { ...c, [field]: value } : c))
  }

  const toggleCategory = (id: string, category: 'science' | 'nursing' | 'general') => {
    setCourses(courses.map(c => {
      if (c.id === id) {
        const hasCategory = c.categories.includes(category)
        let newCategories: ('science' | 'nursing' | 'general')[]
        
        if (hasCategory) {
          newCategories = c.categories.filter(cat => cat !== category)
          if (newCategories.length === 0) newCategories = ['general']
        } else {
          newCategories = [...c.categories.filter(cat => cat !== 'general'), category]
        }
        
        return { ...c, categories: newCategories }
      }
      return c
    }))
  }

  const calculateGPA = (courseList: Course[], filterType?: string) => {
    let filtered = courseList.filter(c => !c.isTransfer)
    
    if (filterType === 'science') {
      filtered = filtered.filter(c => c.categories.includes('science'))
    } else if (filterType === 'nursing') {
      filtered = filtered.filter(c => c.categories.includes('nursing'))
    } else if (filterType === 'last60') {
      const totalCredits = filtered.reduce((sum, c) => sum + c.credits, 0)
      let creditsCount = 0
      let temp = []
      for (let i = filtered.length - 1; i >= 0; i--) {
        if (creditsCount >= 60) break
        temp.unshift(filtered[i])
        creditsCount += filtered[i].credits
      }
      filtered = temp
    }

    const totalPoints = filtered.reduce((sum, c) => sum + (gradePoints[c.grade] || 0) * c.credits, 0)
    const totalCredits = filtered.reduce((sum, c) => sum + c.credits, 0)
    return totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00'
  }

  const handleTranscriptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isUltimate) {
      alert('🔒 AI Transcript Analysis is only available for Ultimate members. Upgrade to unlock!')
      return
    }

    const file = e.target.files?.[0]
    if (!file || file.type !== 'application/pdf') {
      alert('Please upload a PDF file')
      return
    }

    setUploading(true)
    setAnalyzing(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      
      const parseResponse = await fetch('/api/parse-pdf', {
        method: 'POST',
        body: formData
      })
      
      const { text, error } = await parseResponse.json()
      
      if (error || !text) {
        alert('❌ Failed to extract text from PDF. Please try manual entry.')
        setUploading(false)
        setAnalyzing(false)
        return
      }

      const aiResponse = await fetch('/api/analyze-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })

      const data = await aiResponse.json()
      const content = data.choices?.[0]?.message?.content || ''
      
      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0])
        const coursesWithIds = extracted.map((c: any) => ({
          ...c,
          id: Math.random().toString(),
          categories: c.categories || ['general'],
          isTransfer: c.isTransfer || false
        }))
        
        setCourses([...courses, ...coursesWithIds])
        alert(`✅ Successfully extracted ${coursesWithIds.length} courses! You can upload another transcript or edit the courses below.`)
      } else {
        alert('❌ Could not parse transcript. Please try manual entry.')
      }
    } catch (error) {
      console.error(error)
      alert('❌ Error analyzing transcript. Please try manual entry.')
    }

    setUploading(false)
    setAnalyzing(false)
    e.target.value = ''
  }

  const saveCalculation = async () => {
    if (!userId) {
      alert('Please log in to save calculations')
      return
    }

    if (!calculationName.trim()) {
      alert('Please enter a name for this calculation')
      return
    }

    const calculation = {
      user_id: userId,
      calculation_name: calculationName,
      courses: courses,
      science_gpa: parseFloat(calculateGPA(courses, 'science')),
      overall_gpa: parseFloat(calculateGPA(courses)),
      last60_gpa: parseFloat(calculateGPA(courses, 'last60')),
      nursing_gpa: parseFloat(calculateGPA(courses, 'nursing'))
    }

    await supabase.from('gpa_calculations').insert(calculation)
    
    const { data: calcs } = await supabase
      .from('gpa_calculations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (calcs) setSavedCalculations(calcs)

    alert('✅ Calculation saved successfully!')
    setCalculationName('')
  }

  const loadCalculation = (calc: any) => {
    setCourses(calc.courses || [])
    setCalculationName(calc.calculation_name)
  }

  const exportToPDF = () => {
    const gpas = {
      science: calculateGPA(courses, 'science'),
      overall: calculateGPA(courses),
      last60: calculateGPA(courses, 'last60'),
      nursing: calculateGPA(courses, 'nursing')
    }

    const doc = new jsPDF()
    
    doc.setFontSize(20)
    doc.text('GPA CALCULATION REPORT', 20, 20)
    
    doc.setFontSize(12)
    doc.text(calculationName || 'Unnamed Calculation', 20, 30)
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 20, 37)
    
    doc.setFontSize(16)
    doc.text('SUMMARY', 20, 50)
    
    doc.setFontSize(12)
    doc.text(`Science GPA: ${gpas.science}`, 20, 60)
    doc.text(`Overall GPA: ${gpas.overall}`, 20, 67)
    doc.text(`Last 60 Credits: ${gpas.last60}`, 20, 74)
    doc.text(`Nursing GPA: ${gpas.nursing}`, 20, 81)
    
    doc.setFontSize(10)
    doc.text('(Transfer courses excluded from calculations)', 20, 88)
    
    doc.setFontSize(16)
    doc.text(`COURSE BREAKDOWN (${courses.length} courses)`, 20, 100)
    
    doc.setFontSize(10)
    let yPos = 110
    courses.forEach((c, i) => {
      if (yPos > 270) {
        doc.addPage()
        yPos = 20
      }
      const transfer = c.isTransfer ? ' [TRANSFER - Not in GPA]' : ''
      doc.text(`${i + 1}. ${c.name}${transfer}`, 20, yPos)
      doc.text(`Grade: ${c.grade} | Credits: ${c.credits} | Categories: ${c.categories.join(', ')}`, 30, yPos + 5)
      if (c.year || c.term) {
        doc.text(`${c.term || ''} ${c.year || ''}`, 30, yPos + 10)
        yPos += 15
      } else {
        yPos += 12
      }
    })
    
    doc.save(`GPA-Calculation-${new Date().toISOString().split('T')[0]}.pdf`)
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar 
        isLoggedIn={isLoggedIn} 
        userEmail={userEmail} 
        isAdmin={userEmail === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'ml-20' : 'ml-64'}`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-6 py-4 flex justify-end">
          {!isLoggedIn && (
            <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition">
              Login
            </Link>
          )}
        </div>

        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">🎓 GPA Calculator</h1>
            <p className="text-indigo-200">Calculate your Science, Overall, Last 60 Credits, and Nursing GPAs</p>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
            <div className="flex gap-4 mb-6">
              <button
                onClick={() => setMode('manual')}
                className={`flex-1 py-4 rounded-xl font-semibold transition ${
                  mode === 'manual'
                    ? 'bg-gradient-to-r from-purple-600 to-pink-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ✍️ Manual Entry
              </button>
              <button
                onClick={() => {
                  if (!isUltimate) {
                    alert('🔒 AI Transcript Analysis is Ultimate-only! Upgrade to unlock this feature.')
                    return
                  }
                  setMode('ai')
                }}
                className={`flex-1 py-4 rounded-xl font-semibold transition relative ${
                  mode === 'ai'
                    ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                🤖 Transcript Analyzer (Auto-Fill)
                {!isUltimate && <span className="absolute top-2 right-2 bg-purple-500 text-white text-xs px-2 py-1 rounded-full">Ultimate</span>}
              </button>
            </div>

            {mode === 'ai' && isUltimate && (
              <div className="border-2 border-dashed border-purple-300 rounded-xl p-8 text-center bg-purple-50">
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleTranscriptUpload}
                  className="hidden"
                  id="transcript-upload"
                  disabled={analyzing}
                />
                <label htmlFor="transcript-upload" className={`cursor-pointer ${analyzing ? 'opacity-50' : ''}`}>
                  <div className="text-6xl mb-4">📄</div>
                  <h3 className="text-xl font-bold text-gray-800 mb-2">
                    {analyzing ? '🔄 Analyzing Transcript...' : '📤 Upload Your Transcript'}
                  </h3>
                  <p className="text-gray-600 mb-4">
                    {analyzing ? 'AI is extracting courses and grades...' : 'Upload multiple transcripts from each school you attended! Each upload adds courses to your list.'}
                  </p>
                  {!analyzing && (
                    <div className="inline-block px-6 py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition">
                      Choose File
                    </div>
                  )}
                </label>
              </div>
            )}
          </div>

          {courses.length > 0 && (
            <>
              <div className="grid md:grid-cols-4 gap-4 mb-6">
                <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-green-200">
                  <div className="text-3xl mb-2">🔬</div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-1">Science GPA</h3>
                  <p className="text-3xl font-bold text-green-600">{calculateGPA(courses, 'science')}</p>
                  <p className="text-xs text-gray-500 mt-1">{courses.filter(c => c.categories.includes('science') && !c.isTransfer).length} courses</p>
                </div>
                <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-blue-200">
                  <div className="text-3xl mb-2">📚</div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-1">Overall GPA</h3>
                  <p className="text-3xl font-bold text-blue-600">{calculateGPA(courses)}</p>
                  <p className="text-xs text-gray-500 mt-1">{courses.filter(c => !c.isTransfer).length} courses</p>
                </div>
                <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-purple-200">
                  <div className="text-3xl mb-2">⏱️</div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-1">Last 60 Credits</h3>
                  <p className="text-3xl font-bold text-purple-600">{calculateGPA(courses, 'last60')}</p>
                  <p className="text-xs text-gray-500 mt-1">Most recent courses</p>
                </div>
                <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-pink-200">
                  <div className="text-3xl mb-2">🩺</div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-1">Nursing GPA</h3>
                  <p className="text-3xl font-bold text-pink-600">{calculateGPA(courses, 'nursing')}</p>
                  <p className="text-xs text-gray-500 mt-1">{courses.filter(c => c.categories.includes('nursing') && !c.isTransfer).length} courses</p>
                </div>
              </div>
              
              {courses.some(c => c.isTransfer) && (
                <div className="bg-orange-50 border-2 border-orange-300 rounded-xl p-4 mb-6">
                  <div className="flex items-start gap-3">
                    <div className="text-3xl">⚠️</div>
                    <div>
                      <h3 className="font-bold text-orange-800 mb-1">Transfer Courses Detected</h3>
                      <p className="text-sm text-orange-700">
                        <strong>{courses.filter(c => c.isTransfer).length} transfer course(s)</strong> are excluded from GPA calculations. 
                        For accurate GPA calculations, please upload official transcripts directly from each institution you attended.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-gray-800">📋 Courses ({courses.length})</h2>
              <button onClick={addCourse} className="px-4 py-2 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 transition">
                ➕ Add Course
              </button>
            </div>

            {courses.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <div className="text-5xl mb-4">📝</div>
                <p>No courses added yet. Click "Add Course" or upload a transcript!</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-100 border-b-2 border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Course Name</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Year/Term</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Grade</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Credits</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Categories</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {courses.map((course, index) => (
                      editingId === course.id ? (
                        <tr key={course.id} className="bg-blue-50">
                          <td className="px-4 py-3">
                            <input
                              type="text"
                              value={course.name}
                              onChange={(e) => updateCourse(course.id, 'name', e.target.value)}
                              className="w-full px-2 py-1 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
                              placeholder="Course name"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              <input
                                type="text"
                                value={course.term || ''}
                                onChange={(e) => updateCourse(course.id, 'term', e.target.value)}
                                className="w-16 px-2 py-1 border rounded text-xs focus:outline-none focus:ring-2 focus:ring-purple-400"
                                placeholder="Fall"
                              />
                              <input
                                type="text"
                                value={course.year || ''}
                                onChange={(e) => updateCourse(course.id, 'year', e.target.value)}
                                className="w-16 px-2 py-1 border rounded text-xs focus:outline-none focus:ring-2 focus:ring-purple-400"
                                placeholder="2024"
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <select
                              value={course.grade}
                              onChange={(e) => updateCourse(course.id, 'grade', e.target.value)}
                              className="px-2 py-1 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
                            >
                              {Object.keys(gradePoints).map(grade => (
                                <option key={grade} value={grade}>{grade}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              value={course.credits}
                              onChange={(e) => updateCourse(course.id, 'credits', parseInt(e.target.value) || 0)}
                              min="0"
                              max="6"
                              className="w-16 px-2 py-1 border rounded text-center focus:outline-none focus:ring-2 focus:ring-purple-400"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1 flex-wrap">
                              <button
                                onClick={() => toggleCategory(course.id, 'science')}
                                className={`px-2 py-1 text-xs rounded ${course.categories.includes('science') ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'}`}
                              >
                                🔬 Sci
                              </button>
                              <button
                                onClick={() => toggleCategory(course.id, 'nursing')}
                                className={`px-2 py-1 text-xs rounded ${course.categories.includes('nursing') ? 'bg-pink-500 text-white' : 'bg-gray-200 text-gray-600'}`}
                              >
                                🩺 Nrs
                              </button>
                              <button
                                onClick={() => updateCourse(course.id, 'isTransfer', !course.isTransfer)}
                                className={`px-2 py-1 text-xs rounded ${course.isTransfer ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-600'}`}
                                title="Toggle transfer course"
                              >
                                🔄 TR
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setEditingId(null)}
                              className="px-3 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600"
                            >
                              ✅ Done
                            </button>
                          </td>
                        </tr>
                      ) : (
                        <tr key={course.id} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                          <td className="px-4 py-4">
                            <p className={`text-sm font-semibold ${course.name ? 'text-gray-800' : 'text-gray-300 italic'}`}>
                              {course.name || 'Course name'}
                            </p>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex gap-1">
                              <span className={`px-2 py-1 text-xs font-medium rounded ${course.term ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-50 text-gray-300 italic'}`}>
                                {course.term || 'Term'}
                              </span>
                              <span className={`px-2 py-1 text-xs font-medium rounded ${course.year ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-50 text-gray-300 italic'}`}>
                                {course.year || 'Year'}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className="px-3 py-1 bg-blue-100 text-blue-700 text-sm font-bold rounded-lg">{course.grade}</span>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex justify-center">
                              <span className="px-3 py-1 bg-gray-100 text-gray-800 text-sm font-bold rounded-lg">{course.credits}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex gap-1 flex-wrap">
                              {course.isTransfer && (
                                <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-semibold rounded-lg">🔄 Transfer</span>
                              )}
                              {course.categories.includes('science') && (
                                <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-lg">🔬 Science</span>
                              )}
                              {course.categories.includes('nursing') && (
                                <span className="px-2 py-1 bg-pink-100 text-pink-700 text-xs font-semibold rounded-lg">🩺 Nursing</span>
                              )}
                              {course.categories.includes('general') && !course.categories.includes('science') && !course.categories.includes('nursing') && (
                                <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs font-semibold rounded-lg">📚 General</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex gap-2 justify-center">
                              <button
                                onClick={() => setEditingId(course.id)}
                                className="px-3 py-2 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 transition shadow-sm"
                              >
                                ✏️ Edit
                              </button>
                              <button
                                onClick={() => removeCourse(course.id)}
                                className="px-3 py-2 bg-red-500 text-white text-sm font-medium rounded-lg hover:bg-red-600 transition shadow-sm"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {courses.length > 0 && (
            <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
              <h3 className="text-lg font-bold text-gray-800 mb-4">💾 Save & Export</h3>
              <div className="flex gap-4">
                <input
                  type="text"
                  value={calculationName}
                  onChange={(e) => setCalculationName(e.target.value)}
                  placeholder="Name this calculation (e.g., 'Fall 2024')"
                  className="flex-1 px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-400"
                />
                <button
                  onClick={saveCalculation}
                  disabled={!isLoggedIn}
                  className="px-6 py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 transition disabled:opacity-50"
                >
                  💾 Save
                </button>
                <button onClick={exportToPDF} className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition">
                  📄 Export PDF
                </button>
              </div>
              {!isLoggedIn && (
                <p className="text-sm text-gray-500 mt-2">Log in to save calculations to your profile</p>
              )}
            </div>
          )}

          {savedCalculations.length > 0 && (
            <div className="bg-white rounded-2xl shadow-xl p-6">
              <h3 className="text-lg font-bold text-gray-800 mb-4">📊 Saved Calculations</h3>
              <div className="grid md:grid-cols-2 gap-4">
                {savedCalculations.map((calc) => (
                  <div key={calc.id} className="border rounded-xl p-4 hover:border-purple-400 transition cursor-pointer" onClick={() => loadCalculation(calc)}>
                    <h4 className="font-bold text-gray-800 mb-2">{calc.calculation_name}</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <p className="text-gray-600">🔬 Science: <span className="font-semibold">{calc.science_gpa}</span></p>
                      <p className="text-gray-600">📚 Overall: <span className="font-semibold">{calc.overall_gpa}</span></p>
                      <p className="text-gray-600">⏱️ Last 60: <span className="font-semibold">{calc.last60_gpa}</span></p>
                      <p className="text-gray-600">🩺 Nursing: <span className="font-semibold">{calc.nursing_gpa}</span></p>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">{new Date(calc.created_at).toLocaleDateString()}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
