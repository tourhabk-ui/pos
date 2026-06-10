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

## Emergency phone numbers — always tappable

```tsx
// Always use tel: links — they work on mobile even without internet
const EMERGENCY_CONTACTS = [
  { label: 'МЧС России', phone: '112' },
  { label: 'МЧС Камчатского края', phone: '+74152235362' },
  { label: 'Горноспасательная служба', phone: '+74152235361' },
];

function EmergencyContacts() {
  return (
    <div>
      {EMERGENCY_CONTACTS.map(c => (
        <a key={c.phone} href={`tel:${c.phone}`} className="ds-btn ds-btn-danger">
          <Phone className="w-4 h-4" /> {c.label}: {c.phone}
        </a>
      ))}
    </div>
  );
}
```

## MChS registration — required for remote routes

When `mchs_registration_required = true` on a route, show before departure:

```tsx
function MCHSRegistrationBlock({ route }: { route: Route }) {
  if (!route.mchs_registration_required) return null;
  return (
    <div className="ds-card border-l-4 border-[var(--warning)] p-4">
      <h3 className="ds-h2 text-base">Требуется регистрация в МЧС</h3>
      <p className="text-sm text-[var(--text-secondary)] mt-1">
        Уведомите МЧС о выходе на маршрут. Бесплатно, онлайн, 5 минут.
      </p>
      <a
        href="https://forms.mchs.gov.ru/registration_tourist_groups/form"
        target="_blank"
        rel="noopener"
        className="ds-btn ds-btn-secondary mt-3 text-sm"
      >
        Зарегистрироваться онлайн
      </a>
      {route.mchs_phone && (
        <a href={`tel:${route.mchs_phone}`} className="ds-btn text-sm mt-2">
          Позвонить в МЧС: {route.mchs_phone}
        </a>
      )}
    </div>
  );
}
```

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
