import { useEffect, useState } from 'react'
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { loginRequest, msalInstance } from './authConfig'
import { logEvent } from './logger'
import CapturePortal from './CapturePortal'
import ReviewPortal from './ReviewPortal'
import AdminAccessPage from './AdminAccessPage'
import './AuthWrapper.css'

const API = '/moneymapping-api'

function LoginPage({ onLogin, loading }) {
  return (
    <div className="mm-auth-bg">
      <div className="mm-auth-card">
        <div className="mm-auth-brand">
          <div className="mm-auth-logo">MM</div>
          <h1>Money Mapping</h1>
          <p>Flying Machine — fixture performance capture</p>
        </div>
        <button className="btn-primary mm-auth-btn" onClick={onLogin} disabled={loading}>
          {loading ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>
      </div>
    </div>
  )
}

function AccessDenied({ email }) {
  return (
    <div className="mm-auth-bg">
      <div className="mm-auth-card">
        <h2>Access denied</h2>
        <p><strong>{email}</strong> is not set up in Money Mapping yet.</p>
        <p className="mm-auth-hint">Ask your admin to assign your store code.</p>
        <button className="btn-outline" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
      </div>
    </div>
  )
}

export default function AuthWrapper() {
  const { accounts } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const [signing, setSigning] = useState(false)
  const [access, setAccess] = useState(undefined) // undefined = loading
  const [view, setView] = useState('review') // admin toggle: 'review' | 'access'

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

  if (!access.isAdmin) {
    return <CapturePortal user={access} />
  }

  return (
    <div>
      <div className="mm-admin-nav">
        <button
          className={view === 'review' ? 'mm-admin-nav-btn active' : 'mm-admin-nav-btn'}
          onClick={() => setView('review')}
        >
          Review captures
        </button>
        <button
          className={view === 'access' ? 'mm-admin-nav-btn active' : 'mm-admin-nav-btn'}
          onClick={() => setView('access')}
        >
          Store access
        </button>
        <span className="mm-admin-nav-user">{access.displayName}</span>
        <button className="mm-admin-nav-signout" onClick={() => msalInstance.logoutRedirect()}>Sign out</button>
      </div>
      {view === 'review' ? <ReviewPortal user={access} /> : <AdminAccessPage user={access} />}
    </div>
  )
}
