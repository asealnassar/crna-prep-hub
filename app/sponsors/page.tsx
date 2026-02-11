'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function Sponsors() {
  const [sponsors, setSponsors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showContactForm, setShowContactForm] = useState(false)
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactMessage, setContactMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    const fetchSponsors = async () => {
      const { data } = await supabase.from('sponsors').select('*').order('display_order')
      setSponsors(data || [])
      setLoading(false)
    }
    fetchSponsors()
  }, [])

  const handleSubmit = async () => {
    if (!contactName.trim() || !contactEmail.trim() || !contactMessage.trim()) {
      alert('Please fill in all fields')
      return
    }
    setSubmitting(true)
    const { error } = await supabase.from('contact_submissions').insert({
      name: contactName,
      email: contactEmail,
      message: contactMessage
    })
    if (!error) {
      setSubmitted(true)
      setContactName('')
      setContactEmail('')
      setContactMessage('')
    } else {
      alert('Something went wrong. Please try again.')
    }
    setSubmitting(false)
  }

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
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
              <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
              <Link href="/sponsors" className="text-white font-semibold">Sponsors</Link>
            </div>
          </div>
        </div>
      </nav>
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">Our Sponsors and Promoters</h1>
          <p className="text-xl text-indigo-200">Thank you to everyone who has helped spread the word about CRNA Prep Hub!</p>
        </div>
        {sponsors.length === 0 ? (
          <div className="text-center py-12"><p className="text-white text-lg">No sponsors yet. Check back soon!</p></div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {sponsors.map((sponsor) => (
              <div key={sponsor.id} className="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition">
                <div className="flex flex-col items-center text-center">
                  {sponsor.image_url ? (
                    <img src={sponsor.image_url} alt={sponsor.name} className="w-24 h-24 rounded-full object-cover mb-4 border-4 border-purple-200" />
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-purple-600 to-pink-500 flex items-center justify-center text-white text-3xl font-bold mb-4">{sponsor.name.charAt(0)}</div>
                  )}
                  <h3 className="text-xl font-bold text-gray-800">{sponsor.name}</h3>
                  {sponsor.title && (<p className="text-purple-600 font-medium">{sponsor.title}</p>)}
                  {sponsor.description && (<p className="text-gray-600 mt-3">{sponsor.description}</p>)}
                  <div className="flex gap-3 mt-4">
                    {sponsor.instagram_url && (<a href={sponsor.instagram_url} target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white text-sm font-semibold rounded-lg hover:opacity-90 transition">Instagram</a>)}
                    {sponsor.website_url && (<a href={sponsor.website_url} target="_blank" rel="noopener noreferrer" className="px-4 py-2 border border-purple-600 text-purple-600 text-sm font-semibold rounded-lg hover:bg-purple-50 transition">Website</a>)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="text-center mt-12">
          <p className="text-indigo-200 mb-4">Want to become a sponsor or promoter?</p>
          <button onClick={() => setShowContactForm(true)} className="inline-block px-6 py-3 bg-white text-purple-600 font-semibold rounded-xl hover:bg-gray-100 transition">Contact Us</button>
        </div>
      </div>

      {/* Contact Form Modal */}
      {showContactForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            {submitted ? (
              <div className="text-center py-8">
                <div className="text-5xl mb-4">✅</div>
                <h3 className="text-2xl font-bold text-gray-800 mb-2">Message Sent!</h3>
                <p className="text-gray-600 mb-6">We'll get back to you soon.</p>
                <button onClick={() => { setShowContactForm(false); setSubmitted(false); }} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Close</button>
              </div>
            ) : (
              <>
                <h3 className="text-2xl font-bold text-gray-800 mb-2">Contact Us</h3>
                <p className="text-gray-600 mb-6">Interested in becoming a sponsor or promoter? Send us a message!</p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                    <input type="text" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                    <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="your@email.com" className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Message *</label>
                    <textarea value={contactMessage} onChange={(e) => setContactMessage(e.target.value)} placeholder="Tell us about yourself and why you'd like to partner with us..." rows={4} className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                </div>
                <div className="flex gap-3 mt-6">
                  <button onClick={() => setShowContactForm(false)} className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition">Cancel</button>
                  <button onClick={handleSubmit} disabled={submitting} className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50">{submitting ? 'Sending...' : 'Send Message'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
