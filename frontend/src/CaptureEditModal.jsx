import { useEffect, useState } from 'react'
import { logEvent } from './logger'

const API = '/moneymapping-api'

// Same-day edit / delete of one capture. The server enforces the same-day
// rule; this only offers the controls for captures it marked editable.
export default function CaptureEditModal({ user, capture, startInDelete = false, onClose, onChanged }) {
  const [labels, setLabels] = useState([])
  const [label, setLabel] = useState(capture.fixture_label || '')
  const [size, setSize] = useState(capture.size != null ? String(capture.size) : '')
  const [styles, setStyles] = useState([])
  const [stylesLoaded, setStylesLoaded] = useState(false)
  const [manual, setManual] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(startInDelete)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const email = encodeURIComponent(user.email)

  useEffect(() => {
    fetch(`${API}/captures/${capture.capture_id}/styles?email=${email}`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d.styles)) throw new Error(d.error || 'Could not load styles')
        setStyles(d.styles)
        setStylesLoaded(true)
      })
      .catch(e => setError(`Could not load this capture's style codes (${e.message}). Close and try again.`))
  }, [capture.capture_id, email])

  useEffect(() => {
    const params = new URLSearchParams({ email: user.email, store_code: capture.store_code, fixture_type: capture.fixture_type })
    fetch(`${API}/fixture-master?${params}`)
      .then(r => r.json())
      .then(d => setLabels((d.fixtures || []).map(f => f.fixture_label)))
      .catch(() => setLabels([]))
  }, [capture.store_code, capture.fixture_type, user.email])

  const splitCodes = text => text.split(/[\n\r,]+/).map(s => s.trim()).filter(Boolean)
  const mergeCodes = (base, extra) => {
    const merged = [...base]
    for (const c of extra) if (!merged.includes(c)) merged.push(c)
    return merged
  }

  const addManual = () => {
    setStyles(prev => mergeCodes(prev, splitCodes(manual)))
    setManual('')
  }

  const save = async () => {
    setBusy(true); setError('')
    try {
      // Include anything pasted but not yet added, so it can't be dropped.
      const finalStyles = mergeCodes(styles, splitCodes(manual))
      const res = await fetch(`${API}/captures/${capture.capture_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, fixture_label: label.trim(), size: size.trim(), styles: finalStyles }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      logEvent(user, 'capture_edit', { capture_id: capture.capture_id, store_code: capture.store_code, styles: finalStyles.length })
      onChanged()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${API}/captures/${capture.capture_id}?email=${email}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      logEvent(user, 'capture_delete', { capture_id: capture.capture_id, store_code: capture.store_code, fixture_type: capture.fixture_type })
      onChanged()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  const title = `${capture.fixture_type}${capture.fixture_label ? ` · ${capture.fixture_label}` : ''}`
  // Keep a previously typed label selectable even if Head Office never set it up.
  const labelOptions = label && !labels.includes(label) ? [label, ...labels] : labels

  return (
    <div className="mm-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="mm-modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="mm-modal-handle" />
        <div className="eyebrow mm-modal-eyebrow">{confirmDelete ? 'Delete capture' : 'Edit capture · today only'}</div>

        <img
          className="mm-edit-photo"
          src={`${API}/captures/${capture.capture_id}/photo?email=${email}`}
          alt={title}
        />
        <div className="mm-edit-title">{title}<span className="mm-preview-store">{capture.store_code}</span></div>

        {confirmDelete ? (
          <>
            <p className="mm-edit-warn">
              Delete this capture? Its photo and {stylesLoaded ? styles.length : capture.style_count} style
              code{(stylesLoaded ? styles.length : capture.style_count) === 1 ? '' : 's'} will be removed. This can't be undone.
            </p>
            {error && <div className="error-bar">{error}</div>}
            <div className="mm-step-actions">
              <button className="btn-outline" onClick={() => (startInDelete ? onClose() : setConfirmDelete(false))} disabled={busy}>Keep it</button>
              <button className="btn-danger" onClick={remove} disabled={busy}>
                <span className="msi">delete</span>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="mm-edit-field">
              <span className="eyebrow">Which {capture.fixture_type.toLowerCase()}?</span>
              {labelOptions.length > 0 ? (
                <select value={label} onChange={e => setLabel(e.target.value)}>
                  <option value="">None</option>
                  {labelOptions.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              ) : (
                <input type="text" value={label} placeholder="e.g. Wall 1 (optional)" onChange={e => setLabel(e.target.value)} />
              )}
            </label>

            <label className="mm-edit-field">
              <span className="eyebrow">Size (optional)</span>
              <input type="number" min="0" value={size} placeholder="e.g. 3" onChange={e => setSize(e.target.value)} />
            </label>

            <div className="mm-edit-field">
              <span className="eyebrow">Style codes{stylesLoaded ? ` · ${styles.length}` : ''}</span>
              <div className="mm-manual-add">
                <textarea
                  rows={1}
                  placeholder="Add a style code, or paste a whole list"
                  value={manual}
                  onChange={e => setManual(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addManual() }
                  }}
                />
                <button className="btn-outline" onClick={addManual} disabled={!stylesLoaded}>
                  <span className="msi">add</span>
                  Add
                </button>
              </div>
              {stylesLoaded && styles.length > 0 && (
                <ul className="mm-style-list">
                  {styles.map(s => (
                    <li key={s}>
                      <span>{s}</span>
                      <button onClick={() => setStyles(prev => prev.filter(x => x !== s))} aria-label={`Remove ${s}`}>
                        <span className="msi">close</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && <div className="error-bar">{error}</div>}

            <div className="mm-step-actions">
              <button className="btn-danger-outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <span className="msi">delete</span>
                Delete
              </button>
              <button className="btn-primary" onClick={save} disabled={busy || !stylesLoaded}>
                <span className="msi">check_circle</span>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
            <button className="btn-outline mm-modal-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          </>
        )}
      </div>
    </div>
  )
}
