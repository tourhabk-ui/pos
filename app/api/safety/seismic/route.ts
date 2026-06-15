/**
 * GET /api/safety/seismic
 * Публичный. Приоритет — КБГС РАН из external_alerts (ingest каждые 20 мин).
 * Fallback — USGS если локальных данных нет (нет свежих записей за 48ч).
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

let usgsCache: { data: unknown; ts: number } | null = null;
const USGS_TTL = 5 * 60 * 1000;

interface SeismicEvent {
  id: string;
  magnitude: number;
  place: string;
  time: number;
  depth: number | null;
}

// Парсим "Землетрясение ML 4.2 — Авачинский залив" → { magnitude, place }
function parseTitleKbgsras(title: string): { magnitude: number; place: string } {
  const magMatch = title.match(/ML?\s*(\d+(?:[.,]\d+)?)/i);
  const magnitude = magMatch ? parseFloat(magMatch[1].replace(',', '.')) : 0;
  const place = title
    .replace(/^Землетрясение\s*/i, '')
    .replace(/ML?\s*\d+(?:[.,]\d+)?\s*[—–-]\s*/i, '')
    .trim() || title;
  return { magnitude, place: place.slice(0, 120) };
}

// Парсим "глубина 15 км" или "15 км глубина" из description
function parseDepth(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*км\s*глуб|глуб[а-я]*\s*(\d+)\s*км/i);
  if (!m) return null;
  return parseInt(m[1] ?? m[2]);
}

async function fetchFromKbgsras(): Promise<{ events: SeismicEvent[]; source: 'kbgsras' } | null> {
  try {
    const { rows } = await pool.query<{
      id: string; title: string; description: string | null; created_at: Date;
    }>(`
      SELECT id::text, title, description, created_at
      FROM external_alerts
      WHERE alert_type = 'earthquake'
        AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY created_at DESC
      LIMIT 15
    `);

    if (rows.length === 0) return null;

    const events: SeismicEvent[] = rows
      .map(r => {
        const { magnitude, place } = parseTitleKbgsras(r.title);
        return {
          id: r.id,
          magnitude,
          place,
          time: new Date(r.created_at).getTime(),
          depth: parseDepth(r.description),
        };
      })
      .filter(e => e.magnitude > 0);

    return events.length > 0 ? { events, source: 'kbgsras' } : null;
  } catch {
    return null;
  }
}

async function fetchFromUsgs(): Promise<{ events: SeismicEvent[]; source: 'usgs' }> {
  if (usgsCache && Date.now() - usgsCache.ts < USGS_TTL) {
    return usgsCache.data as { events: SeismicEvent[]; source: 'usgs' };
  }

  const url =
    'https://earthquake.usgs.gov/fdsnws/event/1/query' +
    '?format=geojson&minlatitude=50&maxlatitude=63&minlongitude=155&maxlongitude=165' +
    '&minmagnitude=2.5&limit=10&orderby=time';

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);

  const raw = await res.json() as {
    features: { id: string; properties: { mag: number; place: string; time: number }; geometry: { coordinates: [number, number, number] } }[];
  };

  const events: SeismicEvent[] = (raw.features ?? []).map(f => ({
    id: f.id,
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: f.properties.time,
    depth: f.geometry.coordinates[2],
  }));

  const result = { events, source: 'usgs' as const };
  usgsCache = { data: result, ts: Date.now() };
  return result;
}

export async function GET() {
  const local = await fetchFromKbgsras();
  if (local) {
    return NextResponse.json({ ...local, updatedAt: new Date().toISOString() });
  }

  try {
    const usgs = await fetchFromUsgs();
    return NextResponse.json({ ...usgs, updatedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: 'Данные временно недоступны', events: [], source: 'none' }, { status: 502 });
  }
}
