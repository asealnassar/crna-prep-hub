'use client'

import { useEffect, useState } from 'react'

export default function InstallPWA() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [showInstall, setShowInstall] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    // Detect iOS
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    setIsIOS(ios)

    // Check if already installed
    const standalone = window.matchMedia('(display-mode: standalone)').matches
    setIsStandalone(standalone)

    // Android/Chrome install prompt
    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setShowInstall(true)
    }

    window.addEventListener('beforeinstallprompt', handler)

    // Show iOS banner if on iOS and not installed
    if (ios && !standalone) {
      setShowInstall(true)
    }

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt) return

    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    
    if (outcome === 'accepted') {
      setShowInstall(false)
    }
    setDeferredPrompt(null)
  }

  if (!showInstall || isStandalone) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 mx-auto max-w-sm z-50 bg-white rounded-2xl shadow-2xl p-4 border-2 border-purple-500">
      <button
        onClick={() => setShowInstall(false)}
        className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 text-xl"
      >
        ✕
      </button>
      <div className="flex items-center gap-4 mb-4">
        <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white text-2xl flex-shrink-0">
          📱
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-gray-900">Install CRNA Prep Hub</h3>
          <p className="text-sm text-gray-600">Get the app experience!</p>
        </div>
      </div>

      {isIOS ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">
            Tap <span className="inline-flex items-center justify-center w-5 h-5 bg-blue-500 text-white rounded text-xs mx-1">↑</span> Share button, then "Add to Home Screen"
          </p>
        </div>
      ) : (
        <button
          onClick={handleInstall}
          className="w-full px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition"
        >
          Install App
        </button>
      )}
    </div>
  )
}
