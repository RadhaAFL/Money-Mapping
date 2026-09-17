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
        <button className="mm-detail-close" onClick={onClose}>
          <span className="msi">close</span>
        </button>
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

function CoverageStats({ user }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    fetch(`${API}/captures/summary?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => setStats(d.error ? null : d))
      .catch(() => setStats(null))
  }, [user.email])

  if (!stats) return null

  return (
    <div className="mm-stats-row">
      <div className="mm-stat-tile">
        <span className="eyebrow">{stats.month}</span>
        <div className="mm-stat-value">{stats.total_stores}</div>
        <div className="mm-stat-label">network stores</div>
      </div>
      <div className="mm-stat-tile">
        <div className="mm-stat-value">{stats.active_stores}</div>
        <div className="mm-stat-label">stores captured this month</div>
      </div>
      <div className="mm-stat-tile">
        <div className="mm-stat-value">{stats.total_captures}</div>
        <div className="mm-stat-label">walls captured this month</div>
      </div>
    </div>
  )
}

function PlanogramPanel({ user }) {
  const [storeCode, setStoreCode] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [planograms, setPlanograms] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [viewing, setViewing] = useState(null)

  const loadPlanograms = () => {
    setListLoading(true)
    fetch(`${API}/planograms?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => setPlanograms(d.planograms || []))
      .catch(() => setPlanograms([]))
      .finally(() => setListLoading(false))
  }
  useEffect(loadPlanograms, [user.email])

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      if (!storeCode || !effectiveDate || !file) throw new Error('Store code, effective date, and file are all required.')
      const form = new FormData()
      form.append('email', user.email)
      form.append('caller_email', user.email)
      form.append('store_code', storeCode)
      form.append('effective_date', effectiveDate)
      form.append('file', file)
      const res = await fetch(`${API}/planograms`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      setSaved('Blueprint uploaded.')
      setStoreCode(''); setEffectiveDate(''); setFile(null)
      loadPlanograms()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mm-planogram-panel card">
      <div className="eyebrow">Store blueprint · Head Office only</div>
      <h3>Planograms</h3>
      <div className="mm-planogram-row">
        <input
          type="text"
          placeholder="Store code"
          value={storeCode}
          onChange={e => setStoreCode(e.target.value.toUpperCase())}
        />
        <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
        <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button className="btn-primary" onClick={submit} disabled={saving}>
          <span className="msi">upload_file</span>
          {saving ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {error && <div className="error-bar">{error}</div>}
      {saved && <div className="saved-bar">{saved}</div>}

      {!listLoading && (
        planograms.length === 0 ? (
          <p className="mm-cc-hint">No blueprints uploaded yet.</p>
        ) : (
          <ul className="mm-planogram-list">
            {planograms.map(p => (
              <li key={p.planogram_id}>
                <span>
                  <strong>{p.store_code}</strong>
                  <span className="mm-planogram-date"> · {p.effective_date}</span>
                </span>
                <button className="btn-outline" onClick={() => setViewing(p)}>
                  <span className="msi">grid_view</span>
                  View
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {viewing && (
        <div className="mm-detail-backdrop" onClick={() => setViewing(null)}>
          <div className="mm-detail-card mm-blueprint-card" onClick={e => e.stopPropagation()}>
            <button className="mm-detail-close" onClick={() => setViewing(null)}>
              <span className="msi">close</span>
            </button>
            <img
              className="mm-blueprint-photo"
              src={`${API}/planograms/${viewing.planogram_id}/file?email=${encodeURIComponent(user.email)}`}
              alt={`Blueprint for ${viewing.store_code}`}
            />
            <div className="mm-detail-meta">
              <div><strong>{viewing.store_code}</strong> — blueprint layout</div>
              <div className="mm-detail-sub">Effective {viewing.effective_date}</div>
            </div>
          </div>
        </div>
      )}
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
        <div className="eyebrow">Head office · review</div>
        <h1>Captures</h1>

        <CoverageStats user={user} />

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
          <div className="mm-review-state">
            <span className="msi">add_a_photo</span>
            No captures match these filters yet.
          </div>
        )}

        <div className="mm-capture-grid">
          {captures.map(c => (
            <div key={c.capture_id} className="mm-capture-card card" onClick={() => setSelected(c)}>
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

        <PlanogramPanel user={user} />
      </main>

      {selected && <CaptureDetail user={user} capture={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
