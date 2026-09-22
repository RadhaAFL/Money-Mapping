import { useEffect, useState } from 'react'
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { loginRequest, msalInstance } from './authConfig'
import { logEvent } from './logger'
import CapturePortal from './CapturePortal'
import ReviewPortal from './ReviewPortal'
import FixtureMasterPage from './FixtureMasterPage'
import flyingMachineLogo from './assets/flying-machine-logo.png'
import './AuthWrapper.css'

const API = '/moneymapping-api'

const STORE_CAPABILITIES = [
  { label: 'Upload wall photos', allowed: true },
  { label: 'View all stores & data', allowed: false },
  { label: 'Edit & alter records', allowed: false },
  { label: 'Download sheets & reports', allowed: false },
]
const HO_CAPABILITIES = [
  { label: 'Upload wall photos', allowed: true },
  { label: 'View all stores & data', allowed: true },
  { label: 'Edit & alter records', allowed: true },
  { label: 'Download sheets & reports', allowed: true },
]

function HeroSplit({ children }) {
  return (
    <div className="mm-hero-split">
      <div className="mm-hero-panel">
        <div className="mm-hero-brand">
          <img src={flyingMachineLogo} alt="Flying Machine" className="mm-hero-logo" />
        </div>
        <div className="mm-hero-copy">
          <div className="mm-hero-headline">
            The art of
            <br />
            <span className="mm-hero-fold">Fold</span> <span className="mm-hero-hang">Hang</span>
          </div>
          <div className="mm-hero-wordmark">
            <span className="mm-hero-rule" />
            Money Mapping
          </div>
        </div>
      </div>
      <div className="mm-hero-content">{children}</div>
    </div>
  )
}

function LoginPage({ onLogin, loading }) {
  return (
    <HeroSplit>
      <div className="mm-auth-card">
        <div className="eyebrow">Sign in</div>
        <h1>Money Mapping</h1>
        <p>Flying Machine — fixture performance capture</p>
        <button className="btn-primary mm-auth-btn" onClick={onLogin} disabled={loading}>
          {!loading && <span className="msi">badge</span>}
          {loading ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>
      </div>
    </HeroSplit>
  )
}

function AccessDenied({ email }) {
  return (
    <HeroSplit>
      <div className="mm-auth-card">
        <div className="mm-auth-logo mm-auth-logo-denied">
          <span className="msi">block</span>
        </div>
        <div className="eyebrow">Access denied</div>
        <h2>Not set up yet</h2>
        <p><strong>{email}</strong> is not set up in Money Mapping yet.</p>
        <p className="mm-auth-hint">
          This app grants store access based on the store login recorded in
          DIM_RLS — ask whoever maintains that table to confirm this email is
          set as a store's EMAIL_ID.
        </p>
        <button className="btn-outline" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
      </div>
    </HeroSplit>
  )
}

function AccessConfirm({ access, role, onRoleChange, storeCode, onStoreCodeChange, onEnter }) {
  const capabilities = role === 'ho' ? HO_CAPABILITIES : STORE_CAPABILITIES
  // Non-admins only ever have the Store role — the Head Office card is
  // informational, not clickable, since their account has no HO capability.
  const canPickRole = access.isAdmin

  return (
    <HeroSplit>
      <div className="mm-auth-card mm-access-confirm">
        <div className="eyebrow">Sign in</div>
        <h1>Choose your access</h1>

        <div className="mm-role-cards">
          <div
            className={`mm-role-card ${role === 'store' ? 'active' : (canPickRole ? 'pickable' : 'disabled')}`}
            onClick={canPickRole ? () => onRoleChange('store') : undefined}
          >
            <span className="msi">add_a_photo</span>
            <div>
              <div className="mm-role-card-title">Store</div>
              <div className="mm-role-card-sub">Store · Mobile</div>
            </div>
          </div>
          <div
            className={`mm-role-card ${role === 'ho' ? 'active' : (canPickRole ? 'pickable' : 'disabled')}`}
            onClick={canPickRole ? () => onRoleChange('ho') : undefined}
          >
            <span className="msi">apartment</span>
            <div>
              <div className="mm-role-card-title">Head Office</div>
              <div className="mm-role-card-sub">Head Office</div>
            </div>
          </div>
        </div>

        <div className="mm-capability-panel">
          <div className="eyebrow">This role can</div>
          <ul>
            {capabilities.map(c => (
              <li key={c.label} className={c.allowed ? 'allowed' : 'denied'}>
                <span className="msi">{c.allowed ? 'check_circle' : 'cancel'}</span>
                {c.label}
              </li>
            ))}
          </ul>
        </div>

        {role === 'store' && !access.isAdmin && (
          <div className="mm-store-panel">
            <div className="eyebrow">Your store</div>
            {access.storeCodes.length > 1 ? (
              <select value={storeCode} onChange={e => onStoreCodeChange(e.target.value)}>
                {access.storeCodes.map(code => <option key={code} value={code}>{code}</option>)}
              </select>
            ) : (
              <div className="mm-store-chip">
                <span className="msi">storefront</span>
                {access.storeCodes[0]}
              </div>
            )}
          </div>
        )}
        {role === 'store' && access.isAdmin && (
          <p className="mm-auth-hint" style={{ marginTop: -8, marginBottom: 16 }}>
            You'll pick which store to capture for on the next screen.
          </p>
        )}

        <button className="btn-primary mm-auth-btn" onClick={onEnter}>
          <span className="msi">login</span>
          Enter as {role === 'ho' ? 'Head Office' : 'Store'}
        </button>
      </div>
    </HeroSplit>
  )
}

export default function AuthWrapper() {
  const { accounts } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const [signing, setSigning] = useState(false)
  const [access, setAccess] = useState(undefined) // undefined = loading
  const [entered, setEntered] = useState(false)
  const [role, setRole] = useState('store') // which card is selected on the access-confirm screen
  const [storeCode, setStoreCode] = useState('')
  const [view, setView] = useState('review') // admin toggle: 'review' | 'fixtures'

  useEffect(() => {
    if (!isAuthenticated || !accounts.length) {
      setAccess(undefined)
      return
    }
    const account = accounts[0]
    const email = account.username
    fetch(`${API}/check-access?email=${encodeURIComponent(email)}`)
      .then(r => r.json())
      .then(data => {
        const user = {
          email,
          displayName: account.name || email,
          isAdmin: !!data.is_admin,
          storeCodes: data.store_codes || [],
        }
        setAccess(data.allowed ? user : null)
        setStoreCode((data.store_codes || [])[0] || '')
        setRole(data.is_admin ? 'ho' : 'store')
        logEvent(user, 'login', { allowed: data.allowed, is_admin: data.is_admin })
      })
      .catch(() => setAccess(null))
  }, [isAuthenticated, accounts])

  if (!isAuthenticated) {
    return (
      <LoginPage
        loading={signing}
        onLogin={() => {
          setSigning(true)
          msalInstance.loginRedirect(loginRequest).catch(() => setSigning(false))
        }}
      />
    )
  }

  if (access === undefined) return null
  if (access === null) return <AccessDenied email={accounts[0]?.username || ''} />

  if (!entered) {
    return (
      <AccessConfirm
        access={access}
        role={role}
        onRoleChange={setRole}
        storeCode={storeCode}
        onStoreCodeChange={setStoreCode}
        onEnter={() => setEntered(true)}
      />
    )
  }

  if (role === 'store') {
    return (
      <CapturePortal
        user={access.isAdmin
          ? access
          : { ...access, storeCodes: [storeCode, ...access.storeCodes.filter(c => c !== storeCode)] }}
        allowAnyStore={access.isAdmin}
      />
    )
  }

  return (
    <div>
      <div className="mm-admin-nav">
        <div className="mm-admin-nav-brand">
          <span className="msi">storefront</span>
          <span>Money Mapping</span>
        </div>
        <div className="mm-role-badge">
          <span className="msi">apartment</span>
          Head Office
        </div>
        <button
          className={view === 'review' ? 'mm-admin-nav-btn active' : 'mm-admin-nav-btn'}
          onClick={() => setView('review')}
        >
          <span className="msi">fact_check</span>
          Review captures
        </button>
        <button
          className={view === 'capture' ? 'mm-admin-nav-btn active' : 'mm-admin-nav-btn'}
          onClick={() => setView('capture')}
        >
          <span className="msi">add_a_photo</span>
          Capture for a store
        </button>
        <button
          className={view === 'fixtures' ? 'mm-admin-nav-btn active' : 'mm-admin-nav-btn'}
          onClick={() => setView('fixtures')}
        >
          <span className="msi">straighten</span>
          Fixture areas
        </button>
        <span className="mm-admin-nav-user">{access.displayName}</span>
        <button className="mm-admin-nav-signout" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
      </div>
      {view === 'review' && <ReviewPortal user={access} />}
      {view === 'capture' && <CapturePortal user={access} allowAnyStore embedded />}
      {view === 'fixtures' && <FixtureMasterPage user={access} />}
    </div>
  )
}
