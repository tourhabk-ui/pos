/**
 * Перепись подозрительных мест — «экскурсия вместо места» (25.09).
 *
 * Только чтение: забирает с прода все места по видам через
 * `/api/cron/places-by-type` (Bearer CRON_SECRET) и печатает те, чьё название
 * или вид подозрительны (`lib/places/name-junk`). Ничего не правит и не
 * прячет: список идёт владельцу, прятать — миграцией после его решения.
 *
 *   CRON_SECRET=... npx tsx scripts/place-name-junk-scan.ts
 */
import { nameJunkSuspect } from '@/lib/places/name-junk';

const BASE = process.env.SITE_URL ?? 'https://vedarai.ru';

interface TypeCount { type: string; count: number }
interface Place { id: string; name: string; visible: boolean; src: string | null }

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
  let scanned = 0;
  const untyped = types.find((t) => t.type === '(не указан)');
  const found: string[] = [];
  for (const t of types) {
    if (t.type === '(не указан)') continue;
    const { places } = await get<{ places: Place[] }>(`/api/cron/places-by-type?type=${encodeURIComponent(t.type)}&limit=500`);
    scanned += places.length;
    for (const p of places) {
      const s = nameJunkSuspect(p.name, t.type);
      if (s) found.push(`${p.id} | ${t.type} | ${p.visible ? 'видно' : 'скрыто'} | «${p.name}» | ${s.reasons.join('; ')}${p.src ? ` | источник: ${p.src}` : ''}`);
    }
  }
  console.log(`видов ${types.length}, мест прочитано ${scanned}${untyped ? `; без вида ${untyped.count} (их эндпоинт не отдаёт списком — не проверены)` : ''}`);
  // Ноль прочитанных — отказ переписи, а не «мусора нет» (§4.0).
  if (scanned === 0) { console.log('ИТОГ: не прочитано ни одного места'); return 1; }
  console.log(`подозрительных: ${found.length}`);
  for (const line of found) console.log(line);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.log(`ИТОГ: перепись упала — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
