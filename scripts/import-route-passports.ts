#!/usr/bin/env tsx
/**
 * import-route-passports.ts
 *
 * Импорт официальных PDF-паспортов маршрутов с visitkamchatka.ru:
 *   1. collect — собрать список PDF со страницы /route-passports/,
 *      скачать в data/route-passports/, манифест с sha256 (идемпотентно:
 *      sha256 не изменился -> скачивание и парсинг пропускаются);
 *   2. parse — текст через pdf-parse, структура через callAIWaterfall
 *      (строгий JSON, «нет данных -> null»); качество ok|partial|failed;
 *   3. map — консервативный маппинг на kamchatka_routes:
 *      matched / ambiguous (НЕ привязывать) / new;
 *   4. apply (только с флагом --apply) — UPDATE matched-маршрутов:
 *      official_passport_url, passport_agency, passport_verified_at.
 *
 * Запуск:
 *   DATABASE_URL=... npx tsx scripts/import-route-passports.ts             # без записи в БД
 *   DATABASE_URL=... npx tsx scripts/import-route-passports.ts --apply     # с записью matched
 *   ... --skip-parse   # без LLM-извлечения (только манифест + маппинг)
 *   ... --limit=10     # ограничить число PDF (отладка)
 *
 * Сеть: страница и PDF качаются напрямую (GitHub Actions runner вне РФ);
 * при недоступности и наличии BRIGHTDATA_API_TOKEN — фоллбэк на BrightData.
 * Отчёт: data/route-passports/report.json + stdout. Правило НЕ ВРАТЬ:
 * не скачалось/не распарсилось/не смапилось — фиксируется, не выдумывается.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  extractPassportLinks,
  mapPassportToRoutes,
  type PassportLink,
  type MappingOutcome,
} from '../lib/import/route-passports';

const PASSPORTS_PAGE = 'https://visitkamchatka.ru/route-passports/';
const DATA_DIR = resolve(process.cwd(), 'data', 'route-passports');
const MANIFEST_PATH = join(DATA_DIR, 'manifest.json');
const REPORT_PATH = join(DATA_DIR, 'report.json');

const APPLY = process.argv.includes('--apply');
const SKIP_PARSE = process.argv.includes('--skip-parse');
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  const n = arg ? Number.parseInt(arg.split('=')[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

interface ManifestEntry {
  title: string;
  agency: string | null;
  season: string | null;
  pdf_url: string;
  sha256: string;
  downloaded_at: string;
  file: string;
  parse_quality?: 'ok' | 'partial' | 'failed';
  extracted?: Record<string, unknown> | null;
}

interface Report {
  started_at: string;
  page_links_found: number;
  downloaded: number;
  skipped_unchanged: number;
  download_failed: string[];
  parsed_ok: number;
  parsed_partial: number;
  parsed_failed: number;
  matched: Array<{ passport: string; route_id: string; route_title: string }>;
  ambiguous: Array<{ passport: string; candidates: Array<{ id: string; title: string }> }>;
  new_routes: string[];
  /** Несколько паспортов смапились на один маршрут: применяется первый, остальные — на ручную разметку */
  conflicts: Array<{ route_id: string; route_title: string; applied: string; skipped: string[] }>;
  applied: number;
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function fetchUrl(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)' },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function fetchPageHtml(url: string): Promise<string | null> {
  const direct = await fetchUrl(url);
  if (direct) return direct.toString('utf8');

  // Фоллбэк — BrightData (если настроен)
  if (process.env.BRIGHTDATA_API_TOKEN) {
    const { fetchViaBrightData } = await import('../lib/scraping/brightdata');
    return fetchViaBrightData(url);
  }
  return null;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function safeFileName(url: string): string {
  const base = url.split('/').filter(Boolean).pop() ?? 'passport.pdf';
  const clean = decodeURIComponent(base).replace(/[^\wа-яё.-]+/gi, '_').slice(0, 110);
  // Префикс от хэша URL: одинаковые basename из разных директорий
  // (/kronotsky/pasport.pdf и /vulkany/pasport.pdf) не затирают друг друга
  const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  return `${urlHash}_${clean}`;
}

function loadManifest(): Record<string, ManifestEntry> {
  if (!existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

// ── PDF: текст ────────────────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer): Promise<string | null> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ── LLM: структура из текста (формат как в admin/import/route-passports) ──

const EXTRACT_PROMPT = `Ты извлекаешь данные из текста паспорта туристического маршрута на Камчатке.
Верни JSON строго в этом формате (без markdown, только JSON):
{
  "distance_km": число или null,
  "elevation_gain_m": целое или null,
  "duration_hours": число или null,
  "duration_days": целое или null,
  "difficulty": "easy" | "medium" | "hard" | "expert" | null,
  "season": "summer" | "winter" | "all" | null,
  "route_type": "radial" | "linear" | "loop" | null,
  "key_points": ["ключевые точки/топонимы маршрута"] или [],
  "mchs_registration_required": true | false | null,
  "contacts": ["телефоны/контакты из документа"] или []
}
Правила: если данных в тексте нет — null или пустой массив, НЕ выдумывай.`;

async function extractStructure(text: string): Promise<Record<string, unknown> | null> {
  try {
    const { callAIWaterfall } = await import('../lib/ai/providers');
    const raw = await callAIWaterfall([
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: text.slice(0, 12000) },
    ]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('ERROR: DATABASE_URL not set\n');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  mkdirSync(DATA_DIR, { recursive: true });
  const manifest = loadManifest();
  const report: Report = {
    started_at: new Date().toISOString(),
    page_links_found: 0,
    downloaded: 0,
    skipped_unchanged: 0,
    download_failed: [],
    parsed_ok: 0,
    parsed_partial: 0,
    parsed_failed: 0,
    matched: [],
    ambiguous: [],
    new_routes: [],
    conflicts: [],
    applied: 0,
  };

  // ── 1. collect ──
  log(`Страница паспортов: ${PASSPORTS_PAGE}`);
  const html = await fetchPageHtml(PASSPORTS_PAGE);
  if (!html) {
    process.stderr.write('ERROR: страница /route-passports/ недоступна (прямо и через BrightData)\n');
    await pool.end();
    process.exit(2);
  }

  let links: PassportLink[] = extractPassportLinks(html, PASSPORTS_PAGE);
  report.page_links_found = links.length;
  log(`Найдено PDF-ссылок: ${links.length}`);
  if (links.length === 0) {
    process.stderr.write('WARNING: на странице не нашлось ни одной PDF-ссылки — вероятно, изменилась вёрстка. Ничего не выдумываем, выходим.\n');
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    await pool.end();
    process.exit(2);
  }
  if (links.length > LIMIT) links = links.slice(0, LIMIT);

  for (const link of links) {
    const key = link.pdfUrl;
    const fileName = safeFileName(link.pdfUrl);
    const filePath = join(DATA_DIR, fileName);

    const buf = await fetchUrl(link.pdfUrl);
    if (!buf) {
      report.download_failed.push(link.pdfUrl);
      log(`  FAIL download: ${link.title}`);
      continue;
    }
    const hash = sha256(buf);

    // Скип только при успешном прошлом парсинге: partial/failed — временные
    // состояния (LLM/сеть могли лежать), их надо ретраить при каждом прогоне
    const prevQuality = manifest[key]?.parse_quality;
    if (manifest[key]?.sha256 === hash && (prevQuality === 'ok' || SKIP_PARSE)) {
      log(`  skip (sha256 не изменился): ${link.title}`);
      report.skipped_unchanged++;
      continue;
    }

    writeFileSync(filePath, buf);
    manifest[key] = {
      title: link.title,
      agency: link.agency,
      season: link.season,
      pdf_url: link.pdfUrl,
      sha256: hash,
      downloaded_at: new Date().toISOString(),
      file: fileName,
    };
    report.downloaded++;

    // ── 2. parse ──
    if (SKIP_PARSE) continue;
    const text = await extractPdfText(buf);
    if (!text) {
      manifest[key].parse_quality = 'failed';
      report.parsed_failed++;
      continue;
    }
    const extracted = await extractStructure(text);
    if (extracted) {
      manifest[key].parse_quality = 'ok';
      manifest[key].extracted = extracted;
      report.parsed_ok++;
    } else {
      manifest[key].parse_quality = 'partial';
      manifest[key].extracted = null;
      report.parsed_partial++;
    }
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  // ── 3. map ──
  const routesResult = await pool.query<{ id: string; title: string }>(
    `SELECT id::text AS id, title FROM kamchatka_routes WHERE title IS NOT NULL`
  );
  const routes = routesResult.rows;
  log(`Маршрутов в БД: ${routes.length}`);

  // Один маршрут — одна привязка: если несколько паспортов (напр. летний и
  // зимний варианты) смапились на один route_id, применяется первый, остальные
  // уходят в conflicts на ручную разметку — молчаливый last-write-wins запрещён
  const toApply = new Map<string, ManifestEntry>();
  for (const entry of Object.values(manifest)) {
    const outcome: MappingOutcome = mapPassportToRoutes(entry.title, routes);
    if (outcome.kind === 'matched') {
      const existing = toApply.get(outcome.route.id);
      if (existing) {
        const conflict = report.conflicts.find(c => c.route_id === outcome.route.id);
        if (conflict) conflict.skipped.push(entry.title);
        else report.conflicts.push({
          route_id: outcome.route.id,
          route_title: outcome.route.title,
          applied: existing.title,
          skipped: [entry.title],
        });
        continue;
      }
      report.matched.push({ passport: entry.title, route_id: outcome.route.id, route_title: outcome.route.title });
      toApply.set(outcome.route.id, entry);
    } else if (outcome.kind === 'ambiguous') {
      report.ambiguous.push({ passport: entry.title, candidates: outcome.candidates });
    } else {
      report.new_routes.push(entry.title);
    }
  }

  // ── 4. apply ──
  if (APPLY) {
    for (const [routeId, entry] of toApply) {
      await pool.query(
        `UPDATE kamchatka_routes
         SET official_passport_url = $2,
             passport_agency       = $3,
             passport_verified_at  = NOW()
         WHERE id = $1`,
        [routeId, entry.pdf_url, entry.agency]
      );
      report.applied++;
    }
  } else {
    log('(dry-run: без --apply привязки в БД не пишутся)');
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log('');
  log('── ОТЧЁТ ─────────────────────────────────');
  log(`ссылок на странице: ${report.page_links_found}`);
  log(`скачано:            ${report.downloaded} (без изменений: ${report.skipped_unchanged}, ошибок: ${report.download_failed.length})`);
  log(`парсинг:            ok ${report.parsed_ok} / partial ${report.parsed_partial} / failed ${report.parsed_failed}`);
  log(`matched:            ${report.matched.length}${APPLY ? ` (применено: ${report.applied})` : ''}`);
  log(`ambiguous:          ${report.ambiguous.length} — на ручную разметку, автопривязки НЕТ`);
  log(`конфликты:          ${report.conflicts.length} — несколько паспортов на один маршрут`);
  log(`new (нет в базе):   ${report.new_routes.length}`);
  for (const a of report.ambiguous) {
    log(`  ? «${a.passport}» → кандидаты: ${a.candidates.map(c => c.title).join(' | ')}`);
  }
  for (const c of report.conflicts) {
    log(`  ! «${c.route_title}»: применён «${c.applied}», пропущены: ${c.skipped.join(' | ')}`);
  }

  await pool.end();
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
