import { useEffect, useState } from 'react'
import './AdminAccessPage.css'

const API = '/moneymapping-api'

export default function AdminAccessPage({ user }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newCodes, setNewCodes] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    fetch(`${API}/store-access?caller_email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setRows(d.access || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const addUser = async () => {
    const email = newEmail.trim().toLowerCase()
    const codes = newCodes.split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
    if (!email || codes.length === 0) {
      setError('Enter an email and at least one store code.')
      return
    }
    setSaving(true); setError('')
    try {
      const res = await fetch(`${API}/store-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, store_codes: codes, caller_email: user.email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setNewEmail(''); setNewCodes('')
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const removeUser = async email => {
    await fetch(`${API}/store-access/${encodeURIComponent(email)}?caller_email=${encodeURIComponent(user.email)}`, {
      method: 'DELETE',
    })
    load()
  }

  return (
    <div className="mm-access-page">
      <h1>Store access</h1>
      <p className="mm-access-sub">Assign each store user the store code(s) they can capture and submit for.</p>

      <div className="mm-access-add">
        <input
          type="text"
          placeholder="user@arvindfashions.com"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
        />
        <input
          type="text"
          placeholder="Store codes, comma-separated (e.g. 9705, 41018)"
          value={newCodes}
          onChange={e => setNewCodes(e.target.value)}
        />
        <button className="btn-primary" onClick={addUser} disabled={saving}>
          {saving ? 'Saving…' : 'Add / update'}
        </button>
      </div>

      {error && <div className="error-bar">{error}</div>}
      {loading && <div className="mm-access-state">Loading…</div>}

      {!loading && (
        <table className="mm-access-table">
          <thead>
            <tr><th>Email</th><th>Store codes</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.email}>
                <td>{r.email}</td>
                <td>{r.store_codes.join(', ')}</td>
                <td><button className="mm-access-remove" onClick={() => removeUser(r.email)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
