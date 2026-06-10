# Offline-First Design — wilderness & expedition apps

## What must work without internet

Priority order for caching:

| Feature | Storage | Why |
|---------|---------|-----|
| SOS coordinates | IndexedDB | Life safety |
| Emergency contacts | localStorage | Life safety |
| Route GPS track (GPX) | Cache API | Navigation |
| Safety data (hazards, difficulty) | Cache API | Decision making |
| Downloaded maps | Cache API | Navigation |
| Cached route pages | Cache API | Planning |
| Booking data (read-only) | IndexedDB | Reference |

## Service worker cache strategy

```javascript
// sw.js — network-first for dynamic data, cache-first for assets
const CACHE_VERSION = 'v1';
const STATIC_ASSETS = ['/offline.html', '/icons/sos.png'];

// Cache static on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// Network-first for API, stale-while-revalidate for pages
self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.url.includes('/api/safety/')) {
    // Safety data: network-first, fall back to cache
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.destination === 'document') {
    // Pages: stale-while-revalidate
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});
```

## IndexedDB schema for offline data

```typescript
// lib/offline/db.ts
export interface OfflineDB {
  sos_events: {
    id: string;
    lat: number;
    lng: number;
    accuracy: number;
    timestamp: number;
    synced: boolean;
  };
  cached_routes: {
    id: string;
    data: RouteData;
    cached_at: number;
    ttl_hours: number;
  };
  downloaded_gpx: {
    route_id: string;
    gpx_content: string;
    downloaded_at: number;
  };
}
```

## Offline UI — show staleness, not errors

```tsx
function OfflineAwareData({ data, cachedAt }: { data: unknown; cachedAt?: Date }) {
  const isStale = cachedAt && Date.now() - cachedAt.getTime() > 24 * 60 * 60 * 1000;

  return (
    <div>
      {isStale && (
        <div className="ds-badge bg-[var(--warning)]/10 text-[var(--warning)] text-xs mb-2">
          Данные от {cachedAt.toLocaleDateString()} — обновите при появлении сети
        </div>
      )}
      {/* render data */}
    </div>
  );
}
```

## GPX download for offline navigation

```tsx
function DownloadGPXButton({ routeId, routeTitle }: { routeId: string; routeTitle: string }) {
  async function download() {
    const res = await fetch(`/api/routes/${routeId}/gpx`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${routeTitle.replace(/\s+/g, '-')}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button onClick={download} className="ds-btn ds-btn-secondary text-sm">
      <Download className="w-4 h-4 mr-1" /> GPX для офлайн навигации
    </button>
  );
}
```

## Organic Maps deep link

Always offer as alternative to in-browser map:

```tsx
function OrganicMapsLink({ lat, lng, name }: { lat: number; lng: number; name: string }) {
  const href = `om://map?lat=${lat}&lon=${lng}&n=${encodeURIComponent(name)}`;
  return (
    <a href={href} className="ds-btn ds-btn-secondary text-sm">
      Открыть в Organic Maps
    </a>
  );
}
```

## PWA manifest — offline installability

```json
{
  "name": "Ведар — туризм на Камчатке",
  "short_name": "Ведар",
  "display": "standalone",
  "background_color": "#0D1117",
  "theme_color": "#D44A0C",
  "start_url": "/?source=pwa",
  "icons": [
    { "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
