const API = '/moneymapping-api'

// Fire-and-forget audit log write — errors are swallowed so a logging
// failure never blocks the user's actual action.
export function logEvent(user, action, details = {}) {
  fetch(`${API}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user?.email || '',
      name: user?.displayName || '',
      action,
      details,
    }),
  }).catch(() => {})
}
