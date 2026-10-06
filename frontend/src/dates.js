// A store's "day" is the Indian calendar day. The API returns CAPTURED_AT as
// naive UTC ("2026-10-05 10:32:27.530788"), so shift by +5:30 before showing
// or comparing dates — otherwise early-morning captures show under the day before.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const istDateOf = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)

export const istToday = () => istDateOf(Date.now())
export const istDaysAgo = n => istDateOf(Date.now() - n * DAY_MS)

export function utcToIst(utcStr) {
  const ms = Date.parse(String(utcStr).slice(0, 19).replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return { date: String(utcStr).slice(0, 10), time: '' }
  const iso = new Date(ms + IST_OFFSET_MS).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}
