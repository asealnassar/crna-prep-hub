'use client'

import { useEffect, useState } from 'react'

export default function InstallPWA() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [showInstall, setShowInstall] = useState(false)

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setShowInstall(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
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

  if (!showInstall) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white rounded-2xl shadow-2xl p-4 max-w-sm border-2 border-purple-500">
      <button
        onClick={() => setShowInstall(false)}
        className="absolute top-2 right-2 text-gray-400 hover:text-gray-600"
      >
        ✕
      </button>
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white text-2xl">
          📱
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-gray-900">Install CRNA Prep Hub</h3>
          <p className="text-sm text-gray-600">Get the app experience!</p>
        </div>
      </div>
      <button
        onClick={handleInstall}
        className="w-full mt-4 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition"
      >
        Install App
      </button>
    </div>
  )
}
