/**
 * scripts/import-osm-geometry.ts
 *
 * Импорт геометрии маршрутов из OpenStreetMap — CLI поверх общего раннера.
 *
 * ── Почему здесь больше нет своей логики (17.08) ────────────────────────────
 *
 * Скрипт держал собственную копию всего: свой Overpass-эндпоинт без фолбэка,
 * свою выборку маршрутов, свой выбор тропы и свой UPDATE. Правило подбора
 * жило в двух местах — а правило в двух местах это два правила, и разъезжаются
 * они молча. Ровно из-за такого разъезда сегодня чинились и вид линии (§12), и
 * реестр синтетики, и подпись действия.
 *
 * Теперь скрипт — тонкая обёртка: разбор аргументов, вызов `runOsmImport`,
 * печать итога. Правило подбора одно и живёт в `lib/import/osm-geometry`.
 *
 * Оговорка о применимости: прогон с GitHub-раннера трижды падал по таймауту
 * соединения — файрвол managed PostgreSQL у Timeweb не пускает внешние адреса.
 * Боевой путь — прод-эндпоинт `/api/cron/osm-import`; этот скрипт остаётся для
 * запуска оттуда, где база достижима.
 *
 * Usage:
 *   DATABASE_URL=<prod> npx tsx scripts/import-osm-geometry.ts --dry-run
 *   DATABASE_URL=<prod> npx tsx scripts/import-osm-geometry.ts --limit 20
 */

import { pool } from '../lib/db-pool';
import { runOsmImport } from '../lib/import/osm-import-runner';

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const parsedLimit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : NaN;
const LIMIT = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 999;

async function main(): Promise<void> {
  const result = await runOsmImport({ limit: LIMIT, dryRun: isDryRun });

  process.stdout.write(
    `${isDryRun ? 'Сухой прогон' : 'Импорт'}: взято ${result.details.length}, `
    + `принято ${result.imported}, отказов ${result.skipped}, ошибок ${result.errors.length}\n`,
  );

  // Причина отказа печатается всегда: «отказов 40» без причин не говорит,
  // чего не хватило — троп поблизости, точек маршрута или однозначности.
  const byReason = new Map<string, number>();
  for (const d of result.details) {
    if (d.status !== 'skipped') continue;
    const key = d.reason ?? 'без причины';
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  отказ ${reason}: ${n}\n`);
  }

  // Что именно предлагается записать — с именем тропы и качеством привязки.
  for (const d of result.details) {
    if (d.status !== 'dry_run' && d.status !== 'imported') continue;
    const name = d.wayName ? `«${d.wayName}»` : `way ${d.wayId}`;
    process.stdout.write(
      `  ${d.title}: ${name}, точек ${d.pts}, `
      + `худшая путевая точка ${d.worstWaypointKm} км, затирается ${d.currentSource ?? 'пусто'}\n`,
    );
  }

  for (const e of result.errors) process.stdout.write(`  ошибка: ${e}\n`);

  await pool.end();
}

main().catch(async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  await pool.end();
  process.exit(1);
});
