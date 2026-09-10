import { useEffect, useState } from 'react'
import './ReviewPortal.css'

const API = '/moneymapping-api'

function CaptureDetail({ user, capture, onClose }) {
  const [styles, setStyles] = useState([])
  useEffect(() => {
    fetch(`${API}/captures/${capture.capture_id}/styles?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => setStyles(d.styles || []))
      .catch(() => setStyles([]))
  }, [capture.capture_id, user.email])

  return (
    <div className="mm-detail-backdrop" onClick={onClose}>
      <div className="mm-detail-card" onClick={e => e.stopPropagation()}>
        <button className="mm-detail-close" onClick={onClose}>✕</button>
        <img
          className="mm-detail-photo"
          src={`${API}/captures/${capture.capture_id}/photo?email=${encodeURIComponent(user.email)}`}
          alt={`${capture.fixture_type} at ${capture.store_code}`}
        />
        <div className="mm-detail-meta">
          <div><strong>{capture.store_code}</strong> — {capture.fixture_type}</div>
          <div className="mm-detail-sub">{capture.submitted_by_name || capture.submitted_by_email} · {capture.captured_at}</div>
        </div>
        <div className="mm-detail-styles">
          <div className="mm-detail-styles-label">{styles.length} style{styles.length === 1 ? '' : 's'} scanned</div>
          <ul>
            {styles.map(s => <li key={s}>{s}</li>)}
          </ul>
        </div>
      </div>
    </div>
  )
}

function PlanogramUpload({ user }) {
  const [fixtureTypes, setFixtureTypes] = useState([])
  const [fixtureType, setFixtureType] = useState('')
  const [storeCode, setStoreCode] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => {
    fetch(`${API}/fixture-types`).then(r => r.json()).then(d => setFixtureTypes(d.fixture_types || []))
  }, [])

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      if (!fixtureType || !effectiveDate || !file) throw new Error('Fixture, effective date, and file are all required.')
      const form = new FormData()
      form.append('email', user.email)
      form.append('caller_email', user.email)
      form.append('fixture_type', fixtureType)
      form.append('effective_date', effectiveDate)
      if (storeCode) form.append('store_code', storeCode)
      form.append('file', file)
      const res = await fetch(`${API}/planograms`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      setSaved('Planogram uploaded.')
      setFixtureType(''); setStoreCode(''); setEffectiveDate(''); setFile(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mm-planogram-panel">
      <h3>Upload planogram</h3>
      <div className="mm-planogram-row">
        <select value={fixtureType} onChange={e => setFixtureType(e.target.value)}>
          <option value="">Fixture…</option>
          {fixtureTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          type="text"
          placeholder="Store code (blank = all stores)"
          value={storeCode}
          onChange={e => setStoreCode(e.target.value)}
        />
        <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
        <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button className="btn-primary" onClick={submit} disabled={saving}>
          {saving ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {error && <div className="error-bar">{error}</div>}
      {saved && <div className="saved-bar">{saved}</div>}
    </div>
  )
}

export default function ReviewPortal({ user }) {
  const [fixtureTypes, setFixtureTypes] = useState([])
  const [storeCode, setStoreCode] = useState('')
  const [fixtureType, setFixtureType] = useState('')
  const [captures, setCaptures] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetch(`${API}/fixture-types`).then(r => r.json()).then(d => setFixtureTypes(d.fixture_types || []))
  }, [])

  const load = () => {
    setLoading(true); setError('')
    const params = new URLSearchParams({ email: user.email })
    if (storeCode) params.set('store_code', storeCode)
    if (fixtureType) params.set('fixture_type', fixtureType)
    fetch(`${API}/captures?${params}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setCaptures(d.captures || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [storeCode, fixtureType])

  return (
    <div className="mm-review-page">
      <main className="mm-review-main">
        <h1>Captures</h1>

        <div className="mm-review-filters">
          <input
            type="text"
            placeholder="Store code"
            value={storeCode}
            onChange={e => setStoreCode(e.target.value.toUpperCase())}
          />
          <select value={fixtureType} onChange={e => setFixtureType(e.target.value)}>
            <option value="">All fixtures</option>
            {fixtureTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {error && <div className="error-bar">{error}</div>}
        {loading && <div className="mm-review-state">Loading…</div>}
        {!loading && captures.length === 0 && !error && (
          <div className="mm-review-state">No captures match these filters yet.</div>
        )}

        <div className="mm-capture-grid">
          {captures.map(c => (
            <div key={c.capture_id} className="mm-capture-card" onClick={() => setSelected(c)}>
              <img
                className="mm-capture-thumb"
                src={`${API}/captures/${c.capture_id}/photo?email=${encodeURIComponent(user.email)}`}
                alt={`${c.fixture_type} at ${c.store_code}`}
                loading="lazy"
              />
              <div className="mm-capture-card-body">
                <div className="mm-capture-card-title">{c.store_code} · {c.fixture_type}</div>
                <div className="mm-capture-card-sub">{c.style_count} styles · {c.captured_at.slice(0, 10)}</div>
              </div>
            </div>
          ))}
        </div>

        <PlanogramUpload user={user} />
      </main>

      {selected && <CaptureDetail user={user} capture={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
