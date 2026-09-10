import { useEffect, useState } from 'react'
import './FixtureMasterPage.css'

const API = '/moneymapping-api'

export default function FixtureMasterPage({ user }) {
  const [fixtureTypes, setFixtureTypes] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)

  const [storeCode, setStoreCode] = useState('')
  const [fixtureType, setFixtureType] = useState('')
  const [fixtureLabel, setFixtureLabel] = useState('')
  const [areaSqft, setAreaSqft] = useState('')

  useEffect(() => {
    fetch(`${API}/fixture-types`).then(r => r.json()).then(d => setFixtureTypes(d.fixture_types || []))
  }, [])

  const load = () => {
    setLoading(true)
    fetch(`${API}/fixture-master?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setRows(d.fixtures || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      if (!storeCode.trim() || !fixtureType || !fixtureLabel.trim() || !areaSqft) {
        throw new Error('Store code, fixture type, fixture label, and area are all required.')
      }
      const res = await fetch(`${API}/fixture-master`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_code: storeCode.trim().toUpperCase(),
          fixture_type: fixtureType,
          fixture_label: fixtureLabel.trim(),
          area_sqft: Number(areaSqft),
          caller_email: user.email,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setSaved('Fixture area saved.')
      setStoreCode(''); setFixtureType(''); setFixtureLabel(''); setAreaSqft('')
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mm-fixture-page">
      <div className="eyebrow">Head office · reference data</div>
      <h1>Fixture areas</h1>
      <p className="mm-fixture-sub">
        Set the floor area of each fixture per store. This is what lets the Power BI
        dashboard compute SSPD (₹/ft²/day) and space-vs-sales once real capture and
        sales data are flowing — without it those numbers can't be calculated.
      </p>

      <div className="mm-fixture-add card">
        <input type="text" placeholder="Store code" value={storeCode} onChange={e => setStoreCode(e.target.value)} />
        <select value={fixtureType} onChange={e => setFixtureType(e.target.value)}>
          <option value="">Fixture type…</option>
          {fixtureTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="text" placeholder="Label (e.g. Wall 1)" value={fixtureLabel} onChange={e => setFixtureLabel(e.target.value)} />
        <input type="number" min="0" step="0.1" placeholder="Area (sq ft)" value={areaSqft} onChange={e => setAreaSqft(e.target.value)} />
        <button className="btn-primary" onClick={submit} disabled={saving}>
          <span className="msi">straighten</span>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <div className="error-bar">{error}</div>}
      {saved && <div className="saved-bar">{saved}</div>}
      {loading && <div className="mm-fixture-state">Loading…</div>}

      {!loading && (
        <table className="mm-fixture-table card">
          <thead>
            <tr><th>Store</th><th>Fixture</th><th>Label</th><th>Area (sq ft)</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.store_code}-${r.fixture_label}`}>
                <td>{r.store_code}</td>
                <td>{r.fixture_type}</td>
                <td>{r.fixture_label}</td>
                <td>{r.area_sqft}</td>
                <td>{r.updated_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
