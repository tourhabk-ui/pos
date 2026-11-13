# Safety Patterns — offline SOS & emergency design

## SOS: offline-first implementation

The SOS button must save coordinates locally BEFORE attempting any network call.

```typescript
// 1. Save to IndexedDB immediately (works offline)
async function triggerSOS(coords: GeolocationCoordinates) {
  const entry = {
    id: crypto.randomUUID(),
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    timestamp: Date.now(),
    synced: false,
  };
  await db.put('sos_events', entry);   // IndexedDB — no network needed

  // 2. Try network sync (will retry via Background Sync if offline)
  try {
    await fetch('/api/safety/sos', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
    await db.patch('sos_events', entry.id, { synced: true });
  } catch {
    // Background Sync will retry when connection returns
    await navigator.serviceWorker.ready.then(sw =>
      sw.sync.register('sos-sync')
    );
  }
}
```

## Service worker: Background Sync for SOS

```javascript
// sw.js
self.addEventListener('sync', event => {
  if (event.tag === 'sos-sync') {
    event.waitUntil(syncPendingSOS());
  }
});

async function syncPendingSOS() {
  const db = await openDB();
  const pending = await db.getAll('sos_events', IDBKeyRange.only(false));  // synced=false
  for (const entry of pending) {
    try {
      await fetch('/api/safety/sos', { method: 'POST', body: JSON.stringify(entry) });
      await db.patch('sos_events', entry.id, { synced: true });
    } catch { /* will retry on next sync */ }
  }
}
```

## Emergency phone numbers — one verified source

On Vedar the numbers are NOT written in a component. A wrong emergency number
on a safety screen is worse than no number.

- The only source is `lib/safety/emergency-numbers.ts`: `FEDERAL_EMERGENCY`
  (112 first), `VERIFIED_REGIONAL` (numbers the owner has verified) and
  `EMERGENCY_NUMBERS` (both, in order). A number that is not in that file is
  not shown anywhere — do not add one from memory, from a web page or from
  this skill.
- Build the link with `telHref(phone)` from the same file: it strips spaces
  and dashes so the link dials on a phone.
- The SOS button is one component — `components/shared/EmergencyAction.tsx`
  (it has the offline branch). Do not write a second SOS button or a bare
  `<a href="tel:112">` copy of it: two buttons for one action drifted apart
  before (#887).

On another project keep the same shape: one file with verified numbers, one
helper for the `tel:` link, one emergency component.

## MChS registration — one door

When `mchs_registration_required = true` on a route, show the block before
departure. On Vedar it already exists — `components/safety/MchsRegistrationBlock`
— and it is the only one:

- its button leads to the platform form `/register`; there is no second
  window on the route card;
- Vedar does not file the registration with MChS and never says
  «зарегистрирован»: the form collects the group data for the MChS
  application and starts return control (`CLAUDE.md` §10).

Guards: `tests/unit/mchs-block-one-door.test.tsx`,
`tests/unit/safety-register-one-watch.test.ts`.

## GPS coordinates: always show & copy

```tsx
function CoordinateDisplay({ lat, lng }: { lat: number; lng: number }) {
  const text = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text)}
      className="font-mono text-sm text-[var(--ocean)] hover:underline"
      title="Скопировать координаты"
    >
      {text}
    </button>
  );
}
```

## Satellite communicator fallback

For routes with no cell coverage, always mention:
- Garmin inReach / SPOT
- PLB (Personal Locator Beacon)
- Satphone rental in Petropavlovsk-Kamchatsky

Show in route safety block when `sat_communicator_required = true`.
