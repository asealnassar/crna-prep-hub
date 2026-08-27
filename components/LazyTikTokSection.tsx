'use client'

import { useEffect, useRef, useState } from 'react'

const VIDEOS = [
  { id: '7674849510807358751' },
  { id: '7621009153716227359' },
  { id: '7674852735669341471' },
  { id: '7611513777145531679' },
  { id: '7674851662963461407' },
]

export default function LazyTikTokSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [shouldLoad, setShouldLoad] = useState(false)

  // Only start loading TikTok's heavy embed script and iframes once this
  // section is actually about to scroll into view - not on initial page
  // load. This was previously costing ~24MB of page weight and was very
  // likely the single largest contributor to a 60+ second LCP.
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setShouldLoad(true)
          observer.disconnect()
        }
      },
      { rootMargin: '0px', threshold: 0.1 } // only trigger once genuinely visible, not pre-emptively
    )

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!shouldLoad) return

    const existing = document.querySelector('script[src="https://www.tiktok.com/embed.js"]')
    if (existing) existing.remove()

    const script = document.createElement('script')
    script.src = 'https://www.tiktok.com/embed.js'
    script.async = true
    document.body.appendChild(script)

    return () => {
      script.remove()
    }
  }, [shouldLoad])

  return (
    <div ref={containerRef} className="bg-gradient-to-br from-black via-gray-900 to-black py-12 sm:py-16 px-4">
      <div className="max-w-5xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur px-4 py-1.5 rounded-full text-xs font-semibold text-white mb-4">
          <span className="text-lg">🎵</span> Follow along on TikTok
        </div>
        <h2 className="text-2xl sm:text-3xl font-black text-white mb-3">See What We're Sharing</h2>
        <p className="text-sm sm:text-base text-gray-400 mb-8 sm:mb-10 max-w-xl mx-auto">Quick tips, real advice, and behind-the-scenes of the CRNA journey — new content every week.</p>

        <div className="flex gap-4 sm:gap-6 overflow-x-auto snap-x snap-mandatory pb-4 mb-8 sm:mb-10 px-4 sm:px-0 sm:justify-center [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {VIDEOS.map((video) => (
            <div key={video.id} className="flex-shrink-0 snap-center">
              {shouldLoad ? (
                <blockquote
                  className="tiktok-embed"
                  cite={`https://www.tiktok.com/@crnaprephub/photo/${video.id}`}
                  data-video-id={video.id}
                  style={{ maxWidth: '280px', minWidth: '260px', margin: '0 auto' }}
                >
                  <section></section>
                </blockquote>
              ) : (
                // Lightweight placeholder - same footprint as the real embed,
                // so there's no layout shift once the real one swaps in.
                <a
                  href={`https://www.tiktok.com/@crnaprephub/photo/${video.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-center justify-center gap-2 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 transition"
                  style={{ maxWidth: '280px', minWidth: '260px', height: '480px', margin: '0 auto' }}
                >
                  <span className="text-4xl">▶️</span>
                  <span className="text-white/60 text-xs">View on TikTok</span>
                </a>
              )}
            </div>
          ))}
        </div>

        <a
          href="https://www.tiktok.com/@crnaprephub"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 sm:px-8 py-3 sm:py-4 bg-white text-black font-bold rounded-full hover:bg-gray-200 transition text-sm sm:text-base"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0 1 15.54 3h-3.09v12.4a2.592 2.592 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6c0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64c0 3.33 2.76 5.7 5.69 5.7c3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z"/></svg>
          Follow @crnaprephub
        </a>
      </div>
    </div>
  )
}
