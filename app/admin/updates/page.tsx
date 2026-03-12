'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function AdminUpdates() {
  const [updates, setUpdates] = useState<any[]>([])
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isAdmin = user?.email === 'asealnassar@gmail.com'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)

      if (!user || user.email !== 'asealnassar@gmail.com') {
        router.push('/dashboard')
        return
      }

      await loadUpdates()
      setLoading(false)
    }
    init()
  }, [])

  const loadUpdates = async () => {
    const { data } = await supabase
      .from('site_updates')
      .select('*')
      .order('created_at', { ascending: false })

    setUpdates(data || [])
  }

  const openEditor = (update?: any) => {
    setEditing(update || {
      title: '',
      description: '',
      category: 'new_feature'
    })
    setShowEditor(true)
  }

  const saveUpdate = async () => {
    if (!editing.title || !editing.description) {
      alert('Title and description are required')
      return
    }

    setSaving(true)

    if (editing.id) {
      await supabase
        .from('site_updates')
        .update({
          title: editing.title,
          description: editing.description,
          category: editing.category,
          updated_at: new Date().toISOString()
        })
        .eq('id', editing.id)
    } else {
      await supabase
        .from('site_updates')
        .insert({
          title: editing.title,
          description: editing.description,
          category: editing.category
        })
    }

    setSaving(false)
    setShowEditor(false)
    setEditing(null)
    loadUpdates()
  }

  const deleteUpdate = async (id: string) => {
    if (!confirm('Delete this update?')) return

    await supabase.from('site_updates').delete().eq('id', id)
    loadUpdates()
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  if (!isAdmin) return null

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar
        isLoggedIn={!!user}
        userEmail={user?.email || ''}
        isAdmin={isAdmin}
        onCollapsedChange={setSidebarCollapsed}
      />

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-between items-center">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Manage Updates</h1>
          <button
            onClick={() => openEditor()}
            className="px-4 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 transition text-sm"
          >
            ➕ New Update
          </button>
        </div>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="space-y-4">
            {updates.map((update) => (
              <div key={update.id} className="bg-white rounded-xl p-4 sm:p-6 shadow-lg">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold">
                        {update.category.replace('_', ' ').toUpperCase()}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-gray-800 mb-2">{update.title}</h3>
                    <p className="text-gray-600 text-sm whitespace-pre-line">{update.description}</p>
                    <p className="text-gray-400 text-xs mt-3">
                      {new Date(update.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openEditor(update)}
                      className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteUpdate(update.id)}
                      className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold mb-4">
              {editing?.id ? 'Edit Update' : 'Create Update'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Category</label>
                <select
                  value={editing?.category || 'new_feature'}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="new_feature">✨ New Feature</option>
                  <option value="improvement">⚡ Improvement</option>
                  <option value="bug_fix">🐛 Bug Fix</option>
                  <option value="coming_soon">🔮 Coming Soon</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={editing?.title || ''}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="Interview History Now Live!"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={editing?.description || ''}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 border rounded-lg resize-none"
                  placeholder="Describe what's new..."
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={saveUpdate}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : editing?.id ? 'Update' : 'Create'}
              </button>
              <button
                onClick={() => setShowEditor(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg font-semibold hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
