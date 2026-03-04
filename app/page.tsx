import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      {/* Banner */}
      <div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-2 sm:py-3 px-4 text-center">
        <Link href="/interview-prep" className="text-black text-xs sm:text-sm font-semibold hover:underline">
          🚀 NEW: School-Specific Interview Style is NOW LIVE for Ultimate members →
        </Link>
      </div>

      {/* Navigation */}
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:py-4">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-3 sm:gap-0">
            <div className="flex items-center gap-3 sm:gap-4 w-full sm:w-auto justify-between sm:justify-start">
              <h1 className="text-xl sm:text-2xl font-bold text-white">CRNA Prep Hub</h1>
              <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-xs sm:text-sm font-medium">Sponsors</Link>
            </div>
            <div className="flex flex-wrap justify-center gap-3 sm:gap-6 text-sm">
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">Interview</Link>
              <Link href="/interview-prep" className="text-white/80 hover:text-white transition hidden sm:inline">School Interview</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
              <Link href="/login" className="bg-white text-indigo-900 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg font-semibold hover:bg-indigo-100 transition text-sm">Login</Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="max-w-7xl mx-auto px-4 py-12 sm:py-16 lg:py-24 text-center">
        <div className="inline-block bg-white/10 backdrop-blur-sm px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-indigo-200 text-xs sm:text-sm mb-4 sm:mb-6">
          ✨ The #1 CRNA School Search Platform
        </div>
        <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-7xl font-bold text-white mb-4 sm:mb-6 leading-tight">
          Your Journey to<br />
          <span className="bg-gradient-to-r from-pink-400 via-purple-400 to-indigo-400 bg-clip-text text-transparent">
            Becoming a CRNA
          </span><br />
          Starts Here
        </h1>
        <p className="text-base sm:text-lg lg:text-xl text-indigo-200 mb-6 sm:mb-10 max-w-2xl mx-auto px-4">
          Search 129+ accredited CRNA programs, filter by your preferences, and practice with AI-powered mock interviews.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4">
          <Link href="/signup" className="bg-gradient-to-r from-pink-500 to-purple-600 text-white px-6 sm:px-8 py-3 sm:py-4 rounded-xl font-semibold text-base sm:text-lg hover:opacity-90 transition shadow-lg shadow-purple-500/30">
            Get Started Free →
          </Link>
          <Link href="/schools" className="bg-white/10 backdrop-blur-sm text-white px-6 sm:px-8 py-3 sm:py-4 rounded-xl font-semibold text-base sm:text-lg hover:bg-white/20 transition border border-white/20">
            Browse Schools
          </Link>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="max-w-5xl mx-auto px-4 mb-12 sm:mb-24">
        <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 sm:p-8 border border-white/10">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-8 text-center">
            <div>
              <div className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-1 sm:mb-2">129+</div>
              <div className="text-xs sm:text-sm lg:text-base text-indigo-300">CRNA Schools</div>
            </div>
            <div>
              <div className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-1 sm:mb-2">50</div>
              <div className="text-xs sm:text-sm lg:text-base text-indigo-300">States Covered</div>
            </div>
            <div>
              <div className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-1 sm:mb-2">AI</div>
              <div className="text-xs sm:text-sm lg:text-base text-indigo-300">Mock Interviews</div>
            </div>
            <div>
              <div className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-1 sm:mb-2">24/7</div>
              <div className="text-xs sm:text-sm lg:text-base text-indigo-300">Access</div>
            </div>
          </div>
        </div>
      </div>

      {/* Interview Prep NOW LIVE Section */}
      <div className="max-w-5xl mx-auto px-4 mb-12 sm:mb-24">
        <div className="bg-gradient-to-r from-green-500/20 to-emerald-500/20 backdrop-blur-md rounded-2xl p-6 sm:p-8 border border-green-500/30">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 sm:gap-6">
            <div>
              <div className="text-green-400 font-semibold text-xs sm:text-sm mb-2">🎉 NOW LIVE - ULTIMATE EXCLUSIVE</div>
              <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">School-Specific Interview Style</h3>
              <p className="text-sm sm:text-base text-indigo-200">Real questions, interview styles, and insider tips for every CRNA program.</p>
            </div>
            <Link href="/interview-prep" className="w-full md:w-auto text-center bg-green-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-green-400 transition whitespace-nowrap text-sm sm:text-base">
              View Now →
            </Link>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="max-w-7xl mx-auto px-4 pb-12 sm:pb-24">
        <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-8 sm:mb-12">Everything You Need to Get Accepted</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 sm:p-8 border border-white/10 hover:bg-white/15 transition">
            <div className="text-3xl sm:text-4xl mb-3 sm:mb-4">🎓</div>
            <h3 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3">School Database</h3>
            <p className="text-sm sm:text-base text-indigo-200">Search and filter through 129+ accredited CRNA programs. Find schools that match your GPA, location, and preferences.</p>
          </div>
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 sm:p-8 border border-white/10 hover:bg-white/15 transition">
            <div className="text-3xl sm:text-4xl mb-3 sm:mb-4">🎤</div>
            <h3 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3">AI Mock Interviews</h3>
            <p className="text-sm sm:text-base text-indigo-200">Practice with our AI interviewer. Get real-time feedback on behavioral, clinical, and custom topic questions.</p>
          </div>
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 sm:p-8 border border-white/10 hover:bg-white/15 transition">
            <div className="text-3xl sm:text-4xl mb-3 sm:mb-4">📊</div>
            <h3 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3">Premium Filters</h3>
            <p className="text-sm sm:text-base text-indigo-200">Unlock advanced filters for GRE requirements, application deadlines, prerequisites, and more to find your perfect match.</p>
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="bg-gradient-to-r from-pink-600 to-purple-600 py-12 sm:py-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3 sm:mb-4">Ready to Start Your CRNA Journey?</h2>
          <p className="text-sm sm:text-base text-white/80 mb-6 sm:mb-8">Join thousands of nursing students preparing for their dream career.</p>
          <Link href="/signup" className="inline-block bg-white text-purple-600 px-6 sm:px-8 py-3 sm:py-4 rounded-xl font-semibold text-base sm:text-lg hover:bg-indigo-100 transition">
            Create Free Account →
          </Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-indigo-950 py-8 sm:py-12">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 sm:gap-0">
            <div className="text-white font-bold text-lg sm:text-xl">CRNA Prep Hub</div>
            <div className="flex flex-wrap justify-center gap-4 sm:gap-8 text-sm sm:text-base text-indigo-300">
              <Link href="/schools" className="hover:text-white transition">Schools</Link>
              <Link href="/interview" className="hover:text-white transition">Interview</Link>
              <Link href="/pricing" className="hover:text-white transition">Pricing</Link>
              <Link href="/login" className="hover:text-white transition">Login</Link>
            </div>
          </div>
          <div className="text-center text-indigo-400 mt-6 sm:mt-8 text-xs sm:text-sm">
            © 2026 CRNA Prep Hub. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  )
}
