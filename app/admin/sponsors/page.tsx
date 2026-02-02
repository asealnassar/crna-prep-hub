'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function AdminSponsors() {
  const [sponsors, setSponsors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editingSponsor, setEditingSponsor] = useState<any>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const supabase = createClient()

  const emptySponsor = { name: '', title: '', image_url: '', website_url: '', instagram_url: '', description: '', display_order: 0 }

  useEffect(() => {
    const fetchSponsors = async () => {
      const { data } = await supabase.from('sponsors').select('*').order('display_order')
      setSponsors(data || [])
      setLoading(false)
    }
    fetchSponsors()
  }, [])

  const uploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const fileExt = file.name.split('.').pop()
    const fileName = Date.now() + '.' + fileExt
    const { error } = await supabase.storage.from('sponsors').upload(fileName, file)
    if (error) { alert('Upload failed: ' + error.message); setUploading(false); return }
    const { data: urlData } = supabase.storage.from('sponsors').getPublicUrl(fileName)
    setEditingSponsor({...editingSponsor, image_url: urlData.publicUrl})
    setUploading(false)
  }

  const saveSponsor = async () => {
    setSaving(true)
    if (isAdding) {
      const { data, error } = await supabase.from('sponsors').insert({ name: editingSponsor.name, title: editingSponsor.title, image_url: editingSponsor.image_url, website_url: editingSponsor.website_url, instagram_url: editingSponsor.instagram_url, description: editingSponsor.description, display_order: editingSponsor.display_order }).select()
      if (!error && data) { setSponsors([...sponsors, data[0]]); setEditingSponsor(null); setIsAdding(false); alert('Sponsor added!') }
      else { alert('Error: ' + error?.message) }
    } else {
      const { error } = await supabase.from('sponsors').update({ name: editingSponsor.name, title: editingSponsor.title, image_url: editingSponsor.image_url, website_url: editingSponsor.website_url, instagram_url: editingSponsor.instagram_url, description: editingSponsor.description, display_order: editingSponsor.display_order }).eq('id', editingSponsor.id)
      if (!error) { setSponsors(sponsors.map(s => s.id === editingSponsor.id ? editingSponsor : s)); setEditingSponsor(null); alert('Sponsor updated!') }
      else { alert('Error: ' + error.message) }
    }
    setSaving(false)
  }

  const deleteSponsor = async (id: string, name: string) => {
    if (!confirm('Delete ' + name + '?')) return
    await supabase.from('sponsors').delete().eq('id', id)
    setSponsors(sponsors.filter(s => s.id !== id))
  }

  if (loading) { return <div className="min-h-screen bg-gray-100 flex items-center justify-center">Loading...</div> }

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold text-purple-600">Admin - Sponsors</h1>
            <div className="flex gap-4">
              <Link href="/admin/schools" className="text-gray-600 hover:text-purple-600">Schools</Link>
              <Link href="/admin/reports" className="text-gray-600 hover:text-purple-600">Reports</Link>
              <Link href="/sponsors" className="text-gray-600 hover:text-purple-600">View Sponsors</Link>
            </div>
          </div>
        </div>
      </nav>
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800">{sponsors.length} Sponsors</h2>
          <button onClick={() => { setEditingSponsor({...emptySponsor}); setIsAdding(true) }} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">+ Add Sponsor</button>
        </div>
        <div className="space-y-4">
          {sponsors.map((sponsor) => (
            <div key={sponsor.id} className="bg-white rounded-xl shadow p-6">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-4">
                  {sponsor.image_url ? (<img src={sponsor.image_url} alt={sponsor.name} className="w-16 h-16 rounded-full object-cover" />) : (<div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-600 to-pink-500 flex items-center justify-center text-white text-xl font-bold">{sponsor.name.charAt(0)}</div>)}
                  <div>
                    <h3 className="font-bold text-lg text-gray-800">{sponsor.name}</h3>
                    {sponsor.title && <p className="text-purple-600">{sponsor.title}</p>}
                    {sponsor.description && <p className="text-sm text-gray-500 mt-1">{sponsor.description}</p>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setEditingSponsor({...sponsor}); setIsAdding(false) }} className="px-4 py-2 bg-purple-500 text-white rounded-lg text-sm hover:bg-purple-600 transition">Edit</button>
                  <button onClick={() => deleteSponsor(sponsor.id, sponsor.name)} className="px-4 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {editingSponsor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 my-8">
            <h3 className="text-xl font-bold text-gray-800 mb-4">{isAdding ? 'Add Sponsor' : 'Edit Sponsor'}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editingSponsor.name || ''} onChange={(e) => setEditingSponsor({...editingSponsor, name: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input type="text" value={editingSponsor.title || ''} onChange={(e) => setEditingSponsor({...editingSponsor, title: e.target.value})} placeholder="e.g., CRNA, ICU Nurse" className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Profile Picture</label>
                {editingSponsor.image_url && (<img src={editingSponsor.image_url} alt="Preview" className="w-20 h-20 rounded-full object-cover mb-2" />)}
                <input type="file" accept="image/*" onChange={uploadImage} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white" />
                {uploading && <p className="text-sm text-purple-600 mt-1">Uploading...</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Instagram URL</label>
                <input type="text" value={editingSponsor.instagram_url || ''} onChange={(e) => setEditingSponsor({...editingSponsor, instagram_url: e.target.value})} placeholder="https://instagram.com/username" className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                <input type="text" value={editingSponsor.website_url || ''} onChange={(e) => setEditingSponsor({...editingSponsor, website_url: e.target.value})} placeholder="https://..." className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={editingSponsor.description || ''} onChange={(e) => setEditingSponsor({...editingSponsor, description: e.target.value})} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Display Order</label>
                <input type="number" value={editingSponsor.display_order || 0} onChange={(e) => setEditingSponsor({...editingSponsor, display_order: parseInt(e.target.value)})} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => { setEditingSponsor(null); setIsAdding(false) }} className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition">Cancel</button>
              <button onClick={saveSponsor} disabled={saving || uploading || !editingSponsor.name} className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50">{saving ? 'Saving...' : isAdding ? 'Add Sponsor' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
