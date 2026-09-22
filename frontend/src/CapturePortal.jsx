import { useEffect, useMemo, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import * as XLSX from 'xlsx'
import { msalInstance } from './authConfig'
import { logEvent } from './logger'
import CategoryContributionPanel from './CategoryContributionPanel'
import './CapturePortal.css'

const API = '/moneymapping-api'
const MAX_DIM = 1600
const JPEG_QUALITY = 0.8

const FIXTURE_META = {
  'Facade':              { icon: 'storefront',        desc: 'Store front / entrance' },
  'Wall':                { icon: 'grid_view',         desc: 'Main wall display' },
  'Hang Rail':            { icon: 'checkroom',         desc: 'Hanging rail' },
  'Table':                { icon: 'table_restaurant',  desc: 'Folded table display' },
  'CTM Table':            { icon: 'table_restaurant',  desc: 'CTM table display' },
  'CTM Wall':             { icon: 'grid_view',         desc: 'CTM wall display' },
  'Denim Table':          { icon: 'table_restaurant',  desc: 'Denim-focused table' },
  'Denim Wall':           { icon: 'dry_cleaning',      desc: 'Denim-focused wall' },
  'Laundered Black':      { icon: 'dark_mode',         desc: 'Laundered black wall' },
  'Mannequin / Window':    { icon: 'accessibility_new', desc: 'Mannequin or window display' },
}
const SIGNATURE_WALLS = ['Denim Wall', 'Laundered Black', 'Mannequin / Window']

// Resize a captured photo client-side before upload so a phone's raw
// camera output (often 4-8 MB) doesn't fully consume the 20 MiB request cap
// on a slow store WiFi connection.
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      let { width, height } = img
      if (width > MAX_DIM || height > MAX_DIM) {
        const scale = MAX_DIM / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url)
        resolve(blob)
      }, 'image/jpeg', JPEG_QUALITY)
    }
    img.onerror = reject
    img.src = url
  })
}

function FixturePickerModal({ fixtureTypes, onPick, onCancel }) {
  const main = fixtureTypes.filter(t => !SIGNATURE_WALLS.includes(t))
  const signature = fixtureTypes.filter(t => SIGNATURE_WALLS.includes(t))
  const primary = main[0]
  const rest = main.slice(1)

  const Card = ({ type, big }) => {
    const meta = FIXTURE_META[type] || { icon: 'category', desc: '' }
    return (
      <button key={type} className={big ? 'mm-fixture-card mm-fixture-card-big' : 'mm-fixture-card'} onClick={() => onPick(type)}>
        <span className="mm-fixture-card-icon"><span className="msi">{meta.icon}</span></span>
        <div>
          <div className="mm-fixture-card-title">{type}</div>
          {big && meta.desc && <div className="mm-fixture-card-desc">{meta.desc}</div>}
        </div>
      </button>
    )
  }

  return (
    <div className="mm-modal-backdrop" onClick={onCancel}>
      <div className="mm-modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="mm-modal-handle" />
        <div className="eyebrow mm-modal-eyebrow">What did you capture?</div>
        {primary && <Card type={primary} big />}
        {rest.length > 0 && (
          <div className="mm-fixture-grid">
            {rest.map(t => <Card key={t} type={t} />)}
          </div>
        )}
        {signature.length > 0 && (
          <>
            <div className="eyebrow mm-modal-eyebrow">Signature walls</div>
            <div className="mm-fixture-grid">
              {signature.map(t => <Card key={t} type={t} />)}
            </div>
          </>
        )}
        <button className="btn-outline mm-modal-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function CapturePortal({ user, allowAnyStore = false, embedded = false }) {
  const [view, setView] = useState('home') // 'home' | 'capture' | 'preview'
  const [pickerOpen, setPickerOpen] = useState(false)
  const [fixtureTypes, setFixtureTypes] = useState([])
  const [allStores, setAllStores] = useState([])
  const [storeCode, setStoreCode] = useState(user.storeCodes[0] || '')
  const [fixtureType, setFixtureType] = useState('')
  const [fixtureLabels, setFixtureLabels] = useState([])
  const [fixtureLabel, setFixtureLabel] = useState('')
  const [photoBlob, setPhotoBlob] = useState(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState('')
  const [scannedStyles, setScannedStyles] = useState([])
  const [manualStyle, setManualStyle] = useState('')
  const [scannerActive, setScannerActive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [recentCaptures, setRecentCaptures] = useState([])

  const videoRef = useRef(null)
  const controlsRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/fixture-types`)
      .then(r => r.json())
      .then(d => setFixtureTypes(d.fixture_types || []))
      .catch(() => setFixtureTypes([]))
  }, [])

  useEffect(() => {
    if (!allowAnyStore) return
    fetch(`${API}/stores?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(d => setAllStores(d.stores || []))
      .catch(() => setAllStores([]))
  }, [allowAnyStore, user.email])

  // Which specific instance of this fixture type (e.g. "Wall 1", "Wall 2")
  // — sourced from whatever Head Office has already set up in Fixture
  // Master for this store+fixture. Falls back to free text if HO hasn't
  // set any up yet for this combination, so capture is never blocked on it.
  useEffect(() => {
    setFixtureLabel('')
    if (!storeCode || !fixtureType) { setFixtureLabels([]); return }
    const params = new URLSearchParams({ email: user.email, store_code: storeCode, fixture_type: fixtureType })
    fetch(`${API}/fixture-master?${params}`)
      .then(r => r.json())
      .then(d => setFixtureLabels((d.fixtures || []).map(f => f.fixture_label)))
      .catch(() => setFixtureLabels([]))
  }, [storeCode, fixtureType, user.email])

  const loadRecentCaptures = () => {
    if (!storeCode) return
    fetch(`${API}/captures?email=${encodeURIComponent(user.email)}&store_code=${encodeURIComponent(storeCode)}`)
      .then(r => r.json())
      .then(d => setRecentCaptures((d.captures || []).slice(0, 6)))
      .catch(() => setRecentCaptures([]))
  }
  useEffect(loadRecentCaptures, [storeCode, user.email])

  useEffect(() => {
    if (!scannerActive) return
    let cancelled = false
    const reader = new BrowserMultiFormatReader()
    reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
      if (cancelled || !result) return
      const text = result.getText()
      setScannedStyles(prev => (prev.includes(text) ? prev : [...prev, text]))
    }).then(controls => { controlsRef.current = controls })
      .catch(() => setError('Could not access the camera for scanning.'))

    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [scannerActive])

  const onPhotoChange = async e => {
    const file = e.target.files?.[0]
    if (!file) return
    const resized = await resizeImage(file)
    setPhotoBlob(resized)
    setPhotoPreviewUrl(URL.createObjectURL(resized))
  }

  const removeStyle = style => setScannedStyles(prev => prev.filter(s => s !== style))
  const addManualStyle = () => {
    // Splits on newlines and/or commas, so pasting a whole list (one per
    // line, or comma-separated) adds every code at once — not just typing
    // a single one.
    const codes = manualStyle.split(/[\n\r,]+/).map(s => s.trim()).filter(Boolean)
    if (codes.length > 0) {
      setScannedStyles(prev => {
        const merged = [...prev]
        for (const code of codes) if (!merged.includes(code)) merged.push(code)
        return merged
      })
    }
    setManualStyle('')
  }

  const onExcelChange = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const workbook = XLSX.read(buf, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      const codes = rows.flat().map(v => String(v ?? '').trim()).filter(Boolean)
      if (codes.length === 0) throw new Error('No style codes found in that file.')
      setScannedStyles(prev => {
        const merged = [...prev]
        for (const code of codes) if (!merged.includes(code)) merged.push(code)
        return merged
      })
      setError('')
    } catch {
      setError('Could not read style codes from that file.')
    }
  }

  const resetCaptureState = () => {
    setFixtureType('')
    setFixtureLabel('')
    setPhotoBlob(null)
    setPhotoPreviewUrl('')
    setScannedStyles([])
    setScannerActive(false)
    setError('')
  }

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      const form = new FormData()
      form.append('email', user.email)
      form.append('name', user.displayName)
      form.append('store_code', storeCode)
      form.append('fixture_type', fixtureType)
      form.append('fixture_label', fixtureLabel.trim())
      form.append('styles', JSON.stringify(scannedStyles))
      form.append('photo', photoBlob, 'capture.jpg')

      const res = await fetch(`${API}/captures`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')

      setSaved(`Captured — ${data.styles_saved} style${data.styles_saved === 1 ? '' : 's'} logged.`)
      logEvent(user, 'capture_submit', { store_code: storeCode, fixture_type: fixtureType, styles: data.styles_saved })
      resetCaptureState()
      setView('home')
      loadRecentCaptures()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const storeOptions = useMemo(() => user.storeCodes, [user.storeCodes])
  const canReview = fixtureType && photoBlob && (fixtureLabels.length === 0 || fixtureLabel)

  return (
    <div className="mm-capture-page">
      {!embedded && (
        <header className="mm-capture-header">
          <div>
            <div className="mm-capture-title">
              <span className="msi">storefront</span>
              Money Mapping
            </div>
            <div className="mm-capture-sub">{user.displayName}</div>
          </div>
          <button className="btn-outline" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
        </header>
      )}

      <main className="mm-capture-main">
        {allowAnyStore ? (
          <label className="mm-field card">
            <span className="eyebrow">Store (Head Office — any store)</span>
            <input
              type="text"
              list="mm-all-stores"
              placeholder="Type or pick a store code…"
              value={storeCode}
              onChange={e => setStoreCode(e.target.value.trim().toUpperCase())}
            />
            <datalist id="mm-all-stores">
              {allStores.map(code => <option key={code} value={code} />)}
            </datalist>
          </label>
        ) : storeOptions.length > 1 && view === 'home' && (
          <label className="mm-field card">
            <span className="eyebrow">Store</span>
            <select value={storeCode} onChange={e => setStoreCode(e.target.value)}>
              {storeOptions.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        )}

        {view === 'home' && (
          <>
            <CategoryContributionPanel user={user} storeCode={storeCode} />

            <div className="mm-field card">
              <span className="eyebrow">Recent captures</span>
              {recentCaptures.length === 0 ? (
                <p className="mm-cc-hint">No captures logged for this store yet.</p>
              ) : (
                <ul className="mm-recent-list">
                  {recentCaptures.map(c => (
                    <li key={c.capture_id}>
                      <span className="msi">{(FIXTURE_META[c.fixture_type] || {}).icon || 'category'}</span>
                      <span>{c.fixture_type}{c.fixture_label ? ` · ${c.fixture_label}` : ''}</span>
                      <span className="mm-recent-date">{c.captured_at.slice(0, 10)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              className="btn-primary mm-submit"
              onClick={() => setPickerOpen(true)}
              disabled={!storeCode}
            >
              <span className="msi">add_a_photo</span>
              Add capture
            </button>
          </>
        )}

        {view === 'capture' && (
          <>
            <div className="mm-capture-breadcrumb">
              <span className="msi">{(FIXTURE_META[fixtureType] || {}).icon || 'category'}</span>
              <span>{fixtureType}</span>
              <button className="mm-link-btn" onClick={() => setPickerOpen(true)}>Change</button>
            </div>

            <label className="mm-field card">
              <span className="eyebrow">Which {fixtureType.toLowerCase()}?</span>
              {fixtureLabels.length > 0 ? (
                <select value={fixtureLabel} onChange={e => setFixtureLabel(e.target.value)}>
                  <option value="">Select…</option>
                  {fixtureLabels.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder={`e.g. ${fixtureType} 1 (optional — not set up by Head Office yet)`}
                  value={fixtureLabel}
                  onChange={e => setFixtureLabel(e.target.value)}
                />
              )}
            </label>

            <label className="mm-field card">
              <span className="eyebrow">Photo</span>
              {photoPreviewUrl
                ? <img className="mm-photo-preview" src={photoPreviewUrl} alt="Fixture capture preview" />
                : (
                  <div className="mm-photo-placeholder">
                    <span className="msi">add_a_photo</span>
                    No photo yet
                  </div>
                )}
              <input type="file" accept="image/*" capture="environment" onChange={onPhotoChange} />
            </label>

            <div className="mm-field card">
              <span className="eyebrow">Styles on this fixture</span>
              {!scannerActive
                ? (
                  <button className="btn-outline" onClick={() => setScannerActive(true)}>
                    <span className="msi">qr_code_scanner</span>
                    Start barcode scan
                  </button>
                )
                : (
                  <div className="mm-scanner">
                    <video ref={videoRef} className="mm-scanner-video" />
                    <button className="btn-outline" onClick={() => setScannerActive(false)}>
                      <span className="msi">stop_circle</span>
                      Stop scanning
                    </button>
                  </div>
                )}

              <div className="mm-manual-add">
                <textarea
                  rows={1}
                  placeholder="Type a style code, or paste a whole list (one per line, or comma-separated)"
                  value={manualStyle}
                  onChange={e => setManualStyle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addManualStyle() }
                  }}
                />
                <button className="btn-outline" onClick={addManualStyle}>
                  <span className="msi">add</span>
                  Add
                </button>
              </div>

              <label className="btn-outline mm-excel-upload">
                <span className="msi">upload_file</span>
                Upload Excel of style codes
                <input type="file" accept=".xlsx,.xls,.csv" onChange={onExcelChange} hidden />
              </label>

              {scannedStyles.length > 0 && (
                <ul className="mm-style-list">
                  {scannedStyles.map(style => (
                    <li key={style}>
                      <span>{style}</span>
                      <button onClick={() => removeStyle(style)} aria-label={`Remove ${style}`}>
                        <span className="msi">close</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && <div className="error-bar">{error}</div>}

            <div className="mm-step-actions">
              <button className="btn-outline" onClick={() => { resetCaptureState(); setView('home') }}>Cancel</button>
              <button className="btn-primary" onClick={() => setView('preview')} disabled={!canReview}>
                <span className="msi">visibility</span>
                Review
              </button>
            </div>
          </>
        )}

        {view === 'preview' && (
          <>
            <div className="mm-field card">
              <span className="eyebrow">Preview</span>
              <img className="mm-photo-preview" src={photoPreviewUrl} alt="Capture preview" />
              <div className="mm-preview-row">
                <span className="msi">{(FIXTURE_META[fixtureType] || {}).icon || 'category'}</span>
                <strong>{fixtureType}{fixtureLabel ? ` — ${fixtureLabel}` : ''}</strong>
                <span className="mm-preview-store">{storeCode}</span>
              </div>
              {scannedStyles.length > 0 ? (
                <ul className="mm-style-list">
                  {scannedStyles.map(style => <li key={style}><span>{style}</span></li>)}
                </ul>
              ) : (
                <p className="mm-cc-hint">No styles scanned — you can still submit, or go back and add some.</p>
              )}
            </div>

            {error && <div className="error-bar">{error}</div>}
            {saved && <div className="saved-bar">{saved}</div>}

            <div className="mm-step-actions">
              <button className="btn-outline" onClick={() => setView('capture')}>
                <span className="msi">edit</span>
                Edit
              </button>
              <button className="btn-primary" onClick={submit} disabled={saving}>
                <span className="msi">check_circle</span>
                {saving ? 'Submitting…' : 'Confirm & submit'}
              </button>
            </div>
          </>
        )}
      </main>

      {pickerOpen && (
        <FixturePickerModal
          fixtureTypes={fixtureTypes}
          onPick={t => { setFixtureType(t); setPickerOpen(false); setView('capture') }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
