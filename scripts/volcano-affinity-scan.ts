/**
 * Перепись «какие места относятся к вулкану» (26.09). Только чтение: забирает
 * с прода места по видам через `/api/cron/places-by-type` (Bearer CRON_SECRET)
 * и печатает для каждого вулкана места, где он назван в названии или начале
 * описания, с расстоянием. Соседи без упоминания — отдельной строкой, для
 * сведения. Ничего не привязывает: список идёт владельцу (lib/places/volcano-affinity).
 *   CRON_SECRET=... npx tsx scripts/volcano-affinity-scan.ts
 */
import { affinityFor, type AffinityPlace } from '@/lib/places/volcano-affinity';

const BASE = process.env.SITE_URL ?? 'https://vedarai.ru';
/** Порог «соседа» — только для печати, ничего не решает. */
const NEAR_KM = 10;

interface TypeCount { type: string; count: number }
interface Row { id: string; name: string; lat: number | null; lng: number | null; visible: boolean; desc: string | null }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return await res.json() as T;
}

async function main(): Promise<number> {
  if (!process.env.CRON_SECRET) { console.log('ИТОГ: CRON_SECRET не задан — перепись не состоялась'); return 2; }
  const { types } = await get<{ types: TypeCount[] }>('/api/cron/places-by-type');
  const all: AffinityPlace[] = [];
  for (const t of types) {
    if (t.type === '(не указан)') continue;
    const { places } = await get<{ places: Row[] }>(`/api/cron/places-by-type?type=${encodeURIComponent(t.type)}&limit=500`);
    for (const p of places) all.push({ ...p, type: t.type, lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng) });
  }
  const volcanoes = all.filter((p) => p.type === 'volcano' && p.visible);
  const others = all.filter((p) => p.type !== 'volcano');
  if (volcanoes.length === 0) { console.log('ИТОГ: вулканов не получено — перепись не состоялась'); return 1; }

  let withHits = 0;
  let total = 0;
  for (const v of volcanoes.sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
    const { mentioned, nearOnly } = affinityFor(v, others, NEAR_KM);
    if (mentioned.length === 0) continue;
    withHits++;
    total += mentioned.length;
    console.log(`\n## ${v.name} (${v.id})`);
    for (const h of mentioned) {
      console.log(`  + ${h.place.name} [${h.place.type}] ${h.km == null ? 'координат нет' : `${h.km} км`} · назван в ${h.where === 'name' ? 'названии' : 'описании'}${h.place.visible ? '' : ' · скрыто'} · ${h.place.id}`);
    }
    if (nearOnly.length > 0) {
      console.log(`  (рядом до ${NEAR_KM} км, вулкан не назван: ${nearOnly.slice(0, 6).map((h) => `${h.place.name} ${h.km} км`).join('; ')})`);
    }
  }
  console.log(`\nИТОГ: вулканов ${volcanoes.length}, с кандидатами ${withHits}, кандидатов ${total}; мест просмотрено ${others.length}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.log(`ИТОГ: перепись упала — ${(e as Error).message}`); process.exit(1); });
