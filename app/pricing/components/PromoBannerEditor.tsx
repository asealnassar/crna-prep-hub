interface EditingBanner {
  banner_text: string
  promo_code: string
  expiry_date: string
  background_color: string
}

interface PromoBannerEditorProps {
  editingBanner: EditingBanner | null
  setEditingBanner: (banner: EditingBanner) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
  saving: boolean
  hasExistingBanner: boolean
}

/**
 * Pure extraction of the admin-only promo-banner editor modal that already
 * existed inline in app/pricing/page.tsx -- same fields, same handlers, same
 * behavior, just out of the main page component. This is unrelated to the
 * per-plan pricing cards; it edits the separate site-wide marketing banner
 * (the `promo_banner` table).
 */
export default function PromoBannerEditor({
  editingBanner,
  setEditingBanner,
  onSave,
  onDelete,
  onClose,
  saving,
  hasExistingBanner,
}: PromoBannerEditorProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4">Edit Promo Banner</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Banner Text (use {'{CODE}'} for promo code)</label>
            <input
              type="text"
              value={editingBanner?.banner_text || ''}
              onChange={(e) => setEditingBanner({ ...(editingBanner as EditingBanner), banner_text: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
              placeholder="LIMITED TIME: Use code {CODE} for $15 OFF!"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Promo Code</label>
            <input
              type="text"
              value={editingBanner?.promo_code || ''}
              onChange={(e) => setEditingBanner({ ...(editingBanner as EditingBanner), promo_code: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
              placeholder="MARCH15"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Expiry Date</label>
            <input
              type="date"
              value={editingBanner?.expiry_date || ''}
              onChange={(e) => setEditingBanner({ ...(editingBanner as EditingBanner), expiry_date: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Background Color (Tailwind classes)</label>
            <select
              value={editingBanner?.background_color || ''}
              onChange={(e) => setEditingBanner({ ...(editingBanner as EditingBanner), background_color: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="from-red-600 via-orange-500 to-red-600">Red to Orange</option>
              <option value="from-blue-600 via-purple-500 to-blue-600">Blue to Purple</option>
              <option value="from-green-600 via-teal-500 to-green-600">Green to Teal</option>
              <option value="from-purple-600 via-pink-500 to-purple-600">Purple to Pink</option>
              <option value="from-yellow-500 via-orange-500 to-yellow-500">Yellow to Orange</option>
            </select>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onSave}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Banner'}
          </button>
          {hasExistingBanner && (
            <button onClick={onDelete} className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700">
              Delete
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg font-semibold hover:bg-gray-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
