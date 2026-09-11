import { useEffect, useState } from 'react'
import './CategoryContributionPanel.css'

const API = '/moneymapping-api'

export default function CategoryContributionPanel({ user, storeCode }) {
  const [categories, setCategories] = useState([])
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => {
    fetch(`${API}/categories`).then(r => r.json()).then(d => setCategories(d.categories || []))
  }, [])

  useEffect(() => {
    if (!storeCode) return
    setLoading(true)
    fetch(`${API}/category-contribution?email=${encodeURIComponent(user.email)}&store_code=${encodeURIComponent(storeCode)}`)
      .then(r => r.json())
      .then(d => {
        const next = {}
        for (const e of d.entries || []) next[e.category] = String(e.pct)
        setValues(next)
      })
      .catch(() => setValues({}))
      .finally(() => setLoading(false))
  }, [storeCode, user.email])

  const total = categories.reduce((sum, c) => sum + (Number(values[c]) || 0), 0)

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      const entries = categories.map(c => ({ category: c, pct: Number(values[c]) || 0 }))
      const res = await fetch(`${API}/category-contribution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, store_code: storeCode, entries }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setSaved('Category contribution saved.')
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <div className="mm-field card mm-cc-panel">
      <span className="eyebrow">Category contribution</span>
      <p className="mm-cc-hint">Enter this store's share of business by category.</p>
      <div className="mm-cc-grid">
        {categories.map(c => (
          <label key={c} className="mm-cc-item">
            <span>{c}</span>
            <div className="mm-cc-input">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={values[c] ?? ''}
                onChange={e => setValues(v => ({ ...v, [c]: e.target.value }))}
              />
              <span>%</span>
            </div>
          </label>
        ))}
      </div>
      <div className={`mm-cc-total ${Math.round(total) === 100 ? 'ok' : ''}`}>
        <span className="eyebrow">Total</span>
        <span>{Math.round(total)}% of 100</span>
      </div>
      {error && <div className="error-bar">{error}</div>}
      {saved && <div className="saved-bar">{saved}</div>}
      <button className="btn-outline" onClick={submit} disabled={saving}>
        <span className="msi">save</span>
        {saving ? 'Saving…' : 'Save contribution'}
      </button>
    </div>
  )
}
