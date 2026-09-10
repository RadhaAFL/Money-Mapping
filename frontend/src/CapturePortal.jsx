import { useEffect, useMemo, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { msalInstance } from './authConfig'
import { logEvent } from './logger'
import './CapturePortal.css'

const API = '/moneymapping-api'
const MAX_DIM = 1600
const JPEG_QUALITY = 0.8

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

export default function CapturePortal({ user }) {
  const [fixtureTypes, setFixtureTypes] = useState([])
  const [storeCode, setStoreCode] = useState(user.storeCodes[0] || '')
  const [fixtureType, setFixtureType] = useState('')
  const [photoBlob, setPhotoBlob] = useState(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState('')
  const [scannedStyles, setScannedStyles] = useState([])
  const [manualStyle, setManualStyle] = useState('')
  const [scannerActive, setScannerActive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const videoRef = useRef(null)
  const controlsRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/fixture-types`)
      .then(r => r.json())
      .then(d => setFixtureTypes(d.fixture_types || []))
      .catch(() => setFixtureTypes([]))
  }, [])

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
    const val = manualStyle.trim()
    if (val && !scannedStyles.includes(val)) setScannedStyles(prev => [...prev, val])
    setManualStyle('')
  }

  const canSubmit = storeCode && fixtureType && photoBlob && !saving

  const submit = async () => {
    setSaving(true); setError(''); setSaved('')
    try {
      const form = new FormData()
      form.append('email', user.email)
      form.append('name', user.displayName)
      form.append('store_code', storeCode)
      form.append('fixture_type', fixtureType)
      form.append('styles', JSON.stringify(scannedStyles))
      form.append('photo', photoBlob, 'capture.jpg')

      const res = await fetch(`${API}/captures`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')

      setSaved(`Captured — ${data.styles_saved} style${data.styles_saved === 1 ? '' : 's'} logged.`)
      logEvent(user, 'capture_submit', { store_code: storeCode, fixture_type: fixtureType, styles: data.styles_saved })

      setFixtureType('')
      setPhotoBlob(null)
      setPhotoPreviewUrl('')
      setScannedStyles([])
      setScannerActive(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const storeOptions = useMemo(() => user.storeCodes, [user.storeCodes])

  return (
    <div className="mm-capture-page">
      <header className="mm-capture-header">
        <div>
          <div className="mm-capture-title">Money Mapping</div>
          <div className="mm-capture-sub">{user.displayName}</div>
        </div>
        <button className="btn-outline" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
      </header>

      <main className="mm-capture-main">
        {storeOptions.length > 1 && (
          <label className="mm-field">
            <span>Store</span>
            <select value={storeCode} onChange={e => setStoreCode(e.target.value)}>
              {storeOptions.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        )}

        <label className="mm-field">
          <span>Fixture</span>
          <select value={fixtureType} onChange={e => setFixtureType(e.target.value)}>
            <option value="">Select a fixture…</option>
            {fixtureTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>

        <label className="mm-field">
          <span>Photo</span>
          {photoPreviewUrl
            ? <img className="mm-photo-preview" src={photoPreviewUrl} alt="Fixture capture preview" />
            : <div className="mm-photo-placeholder">No photo yet</div>}
          <input type="file" accept="image/*" capture="environment" onChange={onPhotoChange} />
        </label>

        <div className="mm-field">
          <span>Styles on this fixture</span>
          {!scannerActive
            ? <button className="btn-outline" onClick={() => setScannerActive(true)}>Start barcode scan</button>
            : (
              <div className="mm-scanner">
                <video ref={videoRef} className="mm-scanner-video" />
                <button className="btn-outline" onClick={() => setScannerActive(false)}>Stop scanning</button>
              </div>
            )}

          <div className="mm-manual-add">
            <input
              type="text"
              placeholder="Or type a style code"
              value={manualStyle}
              onChange={e => setManualStyle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addManualStyle()}
            />
            <button className="btn-outline" onClick={addManualStyle}>Add</button>
          </div>

          {scannedStyles.length > 0 && (
            <ul className="mm-style-list">
              {scannedStyles.map(style => (
                <li key={style}>
                  <span>{style}</span>
                  <button onClick={() => removeStyle(style)} aria-label={`Remove ${style}`}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className="error-bar">{error}</div>}
        {saved && <div className="saved-bar">{saved}</div>}

        <button className="btn-primary mm-submit" onClick={submit} disabled={!canSubmit}>
          {saving ? 'Saving…' : 'Submit capture'}
        </button>
      </main>
    </div>
  )
}
