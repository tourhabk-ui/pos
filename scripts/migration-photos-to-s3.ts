/**
 * scripts/migration-photos-to-s3.ts — снимки, вшитые в миграции hex-литералами
 * (`decode('…', 'hex')`), — в хранилище по маркеру
 * `.github/triggers/migration-photos-to-s3.json`.
 *
 * Зачем (решение владельца 13.10: «согласен, перенеси в S3»). Перепись
 * 13.10: 59 файлов migrations/ несут 154 JPEG, 24,7 МБ байтов в 53 МБ SQL —
 * 95% всего каталога миграций. Байтам фото место в хранилище, а не в базе и не
 * в репозитории (§4.1, 18.09): они раздувают клон, образ и каждый прогон
 * kernel-pg, а галерею мест (`place_gallery_photos`) уборщик cron-images-to-s3
 * в хранилище не увозит вовсе.
 *
 * Как устроено:
 *   - ключ объекта — ПО СОДЕРЖИМОМУ: `migrations/photos/<sha256>.jpg`. Привязка
 *     снимка к месту в миграциях разная (uuid, `OR ark_id`, `IN (…)`, по имени
 *     места, `max(position)+1`), а хэш байтов один и тот же и в SQL, и в строке
 *     базы (`sha256(image_data)`): по нему переписанная миграция и прод-строка
 *     находят свой объект без догадок;
 *   - список (маркер) строится из самих миграций (`--write-marker`) и лежит в
 *     репозитории: что заливается, видно в PR до заливки;
 *   - перед заливкой список сверяется с миграциями заново: расхождение —
 *     отказ целиком, ничего не залито;
 *   - после заливки объект читается обратно по публичному адресу и сверяется
 *     размер и тип: «отправил» не значит «лежит» (порядок тот же, что у
 *     переезда снимков, §4.1); уже лежащий объект того же размера не
 *     перезаливается — повтор прогона безопасен;
 *   - сухой прогон по умолчанию: заливка — только при `"upload": true`.
 *
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/migration-photos-to-s3.ts [--dry-run | --write-marker]
 *
 * Сторож: tests/unit/migration-photos-to-s3.test.ts.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured, s3PublicBase } from '@/lib/storage/s3';

export const MARKER = '.github/triggers/migration-photos-to-s3.json';
/** Свой префикс: вне `places/<uuid>/`, которым распоряжается уборка сирот (lib/storage/orphan-delete). */
export const KEY_PREFIX = 'migrations/photos/';
/** Меньше — не снимок (обрывок), больше — не из этих миграций (самый тяжёлый в переписи — 459 КБ). */
export const MIN_BYTES = 10 * 1024;
export const MAX_BYTES = 2 * 1024 * 1024;
export const CONTENT_TYPE = 'image/jpeg';

export interface MigrationPhoto {
  /** Имя файла миграции. */
  migration: string;
  /** Порядковый номер снимка в файле, с единицы. */
  n: number;
  /** Куда миграция кладёт байты: ближайший INSERT INTO / UPDATE перед decode(. */
  table: string;
  sha256: string;
  bytes: number;
  key: string;
}

/** `decode(` + смежные hex-литералы (Postgres склеивает их в один) + `, 'hex')`. */
const DECODE_RE = /decode\(\s*((?:'[0-9a-f]+'\s*)+),\s*'hex'\)/g;
const STMT_RE = /\b(?:INSERT\s+INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi;

export function keyFor(sha256: string): string {
  return `${KEY_PREFIX}${sha256}.jpg`;
}

/** Снимки одной миграции; не-JPEG или не по размеру — исключение с именем файла и номером. */
export function extractPhotos(sql: string, migration: string): MigrationPhoto[] {
  const out: MigrationPhoto[] = [];
  const stmts: Array<{ index: number; table: string }> = [];
  for (const m of sql.matchAll(STMT_RE)) stmts.push({ index: m.index ?? 0, table: m[1].toLowerCase() });
  let n = 0;
  for (const m of sql.matchAll(DECODE_RE)) {
    n += 1;
    const hex = m[1].replace(/[^0-9a-f]/g, '');
    const buf = Buffer.from(hex, 'hex');
    if (buf.length * 2 !== hex.length) throw new Error(`${migration} #${n}: hex нечётной длины`);
    if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) {
      throw new Error(`${migration} #${n}: ${buf.length} байт вне ${MIN_BYTES}..${MAX_BYTES}`);
    }
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
      throw new Error(`${migration} #${n}: не JPEG (нет ffd8…ffd9)`);
    }
    const at = m.index ?? 0;
    let table = 'unknown';
    for (const s of stmts) { if (s.index < at) table = s.table; else break; }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    out.push({ migration, n, table, sha256, bytes: buf.length, key: keyFor(sha256) });
  }
  return out;
}

/** Байты снимка по записи маркера — из той же миграции, с проверкой хэша. */
export function readPhoto(root: string, item: MigrationPhoto): Buffer {
  const sql = readFileSync(join(root, 'migrations', item.migration), 'utf8');
  let n = 0;
  for (const m of sql.matchAll(DECODE_RE)) {
    n += 1;
    if (n !== item.n) continue;
    const buf = Buffer.from(m[1].replace(/[^0-9a-f]/g, ''), 'hex');
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== item.sha256) throw new Error(`${item.migration} #${item.n}: байты не те, что в маркере (${sha} ≠ ${item.sha256})`);
    return buf;
  }
  throw new Error(`${item.migration} #${item.n}: снимка с таким номером в файле нет`);
}

/** Все снимки всех миграций — в порядке файлов и вхождений. */
export function buildManifest(root: string): MigrationPhoto[] {
  const dir = join(root, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationPhoto[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    if (!sql.includes("'hex')")) continue;
    out.push(...extractPhotos(sql, f));
  }
  return out;
}

export interface Marker {
  upload: boolean;
  run: number;
  note: string;
  items: MigrationPhoto[];
}

export function readMarker(root: string): Marker {
  return JSON.parse(readFileSync(join(root, MARKER), 'utf8')) as Marker;
}

/** Расхождения маркера с миграциями — словами; пусто, если сошлось до байта. */
export function diffMarker(marker: MigrationPhoto[], actual: MigrationPhoto[]): string[] {
  const out: string[] = [];
  const id = (p: MigrationPhoto) => `${p.migration}#${p.n}`;
  const byId = new Map(actual.map((p) => [id(p), p]));
  for (const m of marker) {
    const a = byId.get(id(m));
    if (!a) { out.push(`${id(m)}: в миграциях такого снимка нет`); continue; }
    if (a.sha256 !== m.sha256 || a.bytes !== m.bytes || a.key !== m.key || a.table !== m.table) {
      out.push(`${id(m)}: запись маркера расходится с миграцией`);
    }
    byId.delete(id(m));
  }
  for (const rest of byId.keys()) out.push(`${rest}: снимок есть в миграции, но не в маркере`);
  return out;
}

async function headSize(url: string): Promise<number | null> {
  const res = await fetch(url, { method: 'HEAD' });
  if (res.status !== 200) return null;
  const len = Number(res.headers.get('content-length'));
  return Number.isFinite(len) ? len : null;
}

async function main(): Promise<number> {
  const root = process.cwd();
  if (process.argv.includes('--write-marker')) {
    const items = buildManifest(root);
    let prev: Partial<Marker> = {};
    try { prev = readMarker(root); } catch { /* маркера ещё нет — первый прогон */ }
    const marker: Marker = {
      upload: prev.upload ?? false,
      run: prev.run ?? 1,
      note: prev.note ?? '',
      items,
    };
    writeFileSync(join(root, MARKER), JSON.stringify(marker, null, 2) + '\n');
    const total = items.reduce((s, p) => s + p.bytes, 0);
    console.log(`маркер записан: ${items.length} снимков, ${total} байт, файлов ${new Set(items.map((p) => p.migration)).size}`);
    return 0;
  }

  const dryRun = process.argv.includes('--dry-run');
  const marker = readMarker(root);
  if (!Array.isArray(marker.items) || marker.items.length === 0) {
    // Ноль строк при запуске — отказ, а не успех (§4.0).
    console.error('ОТКАЗ: в маркере нет ни одного снимка.');
    return 1;
  }
  const actual = buildManifest(root);
  const diff = diffMarker(marker.items, actual);
  if (diff.length > 0) {
    for (const d of diff) console.error(`ОТКАЗ: ${d}`);
    console.error('Маркер разошёлся с миграциями — перестройте его (--write-marker). Ничего не залито.');
    return 1;
  }
  const total = marker.items.reduce((s, p) => s + p.bytes, 0);
  console.log(`снимков: ${marker.items.length}, байт: ${total}, ${dryRun ? 'сухой прогон' : 'боевой'}`);
  if (dryRun) {
    const byFile = new Map<string, number>();
    for (const p of marker.items) byFile.set(p.migration, (byFile.get(p.migration) ?? 0) + 1);
    for (const [f, k] of byFile) console.log(`  ${f}: ${k}`);
    return 0;
  }
  if (!isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 2;
  }

  let uploaded = 0, skipped = 0, failed = 0;
  for (const it of marker.items) {
    const url = `${s3PublicBase()}/${it.key}`;
    const have = await headSize(url);
    if (have === it.bytes) { skipped += 1; continue; }
    const body = readPhoto(root, it);
    await uploadToS3(it.key, body, CONTENT_TYPE);
    // Прочитать обратно по публичному адресу: так его увидит браузер.
    const res = await fetch(url);
    const got = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    const sha = createHash('sha256').update(got).digest('hex');
    if (res.status !== 200 || got.length !== it.bytes || sha !== it.sha256 || !type.startsWith(CONTENT_TYPE)) {
      console.error(`НЕ СОШЛОСЬ: ${it.key}: HTTP ${res.status}, ${got.length} из ${it.bytes} байт, тип «${type}»`);
      failed += 1;
    } else {
      uploaded += 1;
    }
  }
  console.log(`залито ${uploaded}, уже лежало ${skipped}, не сошлось ${failed} — из ${marker.items.length}`);
  if (failed > 0) return 1;
  if (uploaded + skipped !== marker.items.length) return 1;
  console.log('Готово: каждый снимок маркера лежит в хранилище и прочитан обратно.');
  return 0;
}

if (process.argv[1]?.endsWith('migration-photos-to-s3.ts')) {
  main().then((code) => process.exit(code), (err) => {
    console.error('ОТКАЗ:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
