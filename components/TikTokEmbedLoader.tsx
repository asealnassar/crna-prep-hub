'use client'

import { useEffect } from 'react'

export default function TikTokEmbedLoader() {
  useEffect(() => {
    // TikTok's embed script only scans the page for .tiktok-embed elements once,
    // the moment it finishes loading. If React hasn't finished rendering those
    // blockquotes into the DOM yet at that exact moment, it silently skips them —
    // which is why the embeds sometimes only appear after a manual refresh.
    // Removing and re-adding a fresh script tag after mount forces it to re-scan
    // the page reliably, every time.
    const existing = document.querySelector('script[src="https://www.tiktok.com/embed.js"]')
    if (existing) existing.remove()

    const script = document.createElement('script')
    script.src = 'https://www.tiktok.com/embed.js'
    script.async = true
    document.body.appendChild(script)

    return () => {
      script.remove()
    }
  }, [])

  return null
}
