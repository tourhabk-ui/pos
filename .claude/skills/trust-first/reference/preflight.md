# Pre-launch Trust Checklist — 12 gates

Run before every public release of a safety-claiming feature. Each gate is binary: PASS or BLOCK.

---

## Gate 1: SOS offline

**Test:** Disable network in DevTools → trigger SOS → re-enable → verify sync fires.

- [ ] Coordinates saved to IndexedDB before any network call
- [ ] Background Sync registration on network failure
- [ ] SOS button visible without scrolling on route/place page (not in menu)

**BLOCK if:** SOS shows "error" when offline, or coordinates not saved locally.

---

## Gate 2: Emergency contacts reachable

**Test:** Open on mobile, tap each emergency number.

- [ ] All numbers render as `<a href="tel:...">` (not plain text)
- [ ] 112 listed first
- [ ] Numbers work on mobile (no spaces/dashes that break tel: protocol)

**BLOCK if:** Any emergency number is plain text or doesn't dial.

---

## Gate 3: Route status accuracy

**Test:** Check a route marked "open" against last known source.

- [ ] Status sourced from real-time data (not hardcoded)
- [ ] Stale status shown with last-updated timestamp
- [ ] Closed/restricted routes cannot be booked

**BLOCK if:** Route status is hardcoded or has no source/timestamp.

---

## Gate 4: Operator verification before booking

**Test:** Attempt to book a tour from an unverified operator.

- [ ] Unverified operators cannot list tours (API enforces, not just UI)
- [ ] Verification badge is server-rendered (not just JS state)
- [ ] Guide certifications shown for technical routes

**BLOCK if:** Booking page reachable for unverified operator.

---

## Gate 5: MChS warning shown

**Test:** Visit a route with `mchs_registration_required = true`.

- [ ] Registration requirement visible above the fold
- [ ] Link to `forms.mchs.gov.ru` works and opens correct form
- [ ] MChS phone shown as clickable `tel:` link

**BLOCK if:** Requirement hidden or link broken.

---

## Gate 6: Price validity

**Test:** Check all price displays.

- [ ] Every price has "from" qualifier or exact conditions defined
- [ ] Cached prices show last-updated date if >24h old
- [ ] No price shown from >7 day old cache

**WARN if:** Prices lack validity dates.

---

## Gate 7: Booking confirmation timing

**Test:** Complete a booking, check confirmation email timing.

- [ ] Confirmation only sent after operator acknowledges (not on payment)
- [ ] User informed "awaiting operator confirmation" after payment
- [ ] Auto-cancel if operator doesn't respond within SLA

**BLOCK if:** Confirmation sent before operator confirmation.

---

## Gate 8: Offline maps downloadable

**Test:** On route page, download GPX, go offline, open in Organic Maps.

- [ ] GPX download button exists and works
- [ ] Organic Maps deep link opens correctly
- [ ] Downloaded file has valid coordinates

**WARN if:** No offline map option on routes requiring navigation.

---

## Gate 9: Stale data labelled

**Test:** Clear network, reload cached pages.

- [ ] Cached pages show "last updated: {date}"
- [ ] Stale data distinguished from fresh data visually
- [ ] No critical safety data (route open/closed, hazards) served stale silently

**BLOCK if:** Safety-critical data served without staleness indicator.

---

## Gate 10: TypeScript strict

```bash
npx tsc --noEmit
```

- [ ] Zero errors
- [ ] No `any` types in safety-critical paths (SOS, booking, auth)

**BLOCK if:** TypeScript errors exist.

---

## Gate 11: Auth on all sensitive routes

**Test:** Open booking/profile/operator endpoints without auth token.

- [ ] All POST /api/bookings/* return 401 without valid JWT
- [ ] All /hub/operator/* pages redirect to login
- [ ] SOS POST accepts unauthenticated requests (it's an emergency)

**BLOCK if:** Booking or operator data accessible without auth.

---

## Gate 12: Mobile usability

**Test:** Test on 375px viewport (iPhone SE), throttled 3G.

- [ ] SOS button reachable with one thumb
- [ ] Emergency contacts tappable (min 44×44px touch target)
- [ ] Core flow (find route → check safety → contact emergency) under 3 taps

**BLOCK if:** SOS unreachable on mobile.

---

## Sign-off template

```
Pre-launch trust checklist — [platform name] [date]
Reviewer: [name]

Gates passed: X/12
Gates blocked: Y
Gates warned: Z

Blocked gates:
- Gate N: [reason]

Decision: [ ] APPROVED TO LAUNCH  [ ] BLOCKED — fix gates above
```
