# Trust Audit — safety-first platform review

Run this audit before any public launch or feature release that touches safety, bookings, or emergency flows.

## 1. SOS / Emergency

- [ ] SOS button is reachable from every route/tour/place page (not buried in settings)
- [ ] SOS works **without internet**: saves GPS coords to IndexedDB first, syncs later
- [ ] Emergency phone numbers render as `<a href="tel:...">` (tappable on mobile)
- [ ] Fallback if GPS unavailable: last known coordinates + timestamp shown
- [ ] SOS confirmation is local-first (no "waiting for server" spinner before saving)

## 2. Route / Place safety data

- [ ] No route shown as "open" without a real-time status source
- [ ] Hazards listed (volcano activity, bears, river crossings, weather) — not "see description"
- [ ] Difficulty rating present and sourced from actual data (not placeholder)
- [ ] MChS registration requirement shown prominently if `mchs_registration_required = true`
- [ ] Nearest medical facility distance shown for remote routes

## 3. Operator verification

- [ ] No tour bookable from an unverified operator
- [ ] Operator verification status visible to user before booking (not after)
- [ ] Guide certifications shown for technical routes (mountain, volcano, water)
- [ ] Operator response time shown if >48h threshold exists

## 4. Booking integrity

- [ ] Booking confirmation only sent after operator actually confirms (not on payment)
- [ ] Cancellation policy shown before payment, not after
- [ ] Group size limits enforced in real-time (no overbooking)
- [ ] Refund flow exists and is documented in the UI

## 5. Prices & availability

- [ ] All prices show validity date or "updated: YYYY-MM-DD"
- [ ] "From ₽X" always has the base case defined (minimum group, minimum duration)
- [ ] Sold-out / unavailable tours cannot be booked (hard block, not warning)
- [ ] No price shown from cache older than 24h without staleness indicator

## 6. Offline claims

- [ ] Every "works offline" claim has a corresponding service worker cache strategy
- [ ] Offline mode tested by disabling network in DevTools before shipping
- [ ] Cached data has TTL — stale data shown with "last updated" timestamp
- [ ] Maps cacheable for offline use (tile pre-download or Organic Maps deep link)

## Scoring

| Score | Meaning |
|-------|---------|
| 0–3 gaps | Ready to ship |
| 4–7 gaps | Fix before marketing to safety-conscious users |
| 8+ gaps | Do not market as a safety platform |
