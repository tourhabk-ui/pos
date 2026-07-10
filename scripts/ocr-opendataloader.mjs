#!/usr/bin/env node
/**
 * ocr-opendataloader.mjs — бесплатный локальный OCR паспортов маршрутов через
 * OpenDataLoader PDF (вместо платного Mistral OCR). Гоняется на GitHub-раннере
 * (там есть Java 11+ и Node 20+).
 *
 * Цикл:
 *   1. GET {BASE}/api/cron/ocr-passports-pending?limit=N — прод отдаёт PDF в
 *      base64 (сам скачивает с РФ-IP; раннеру не нужно тянуть RU-ресурс).
 *   2. OpenDataLoader convert(pdf) -> markdown локально.
 *   3. POST {BASE}/api/cron/ocr-passports-write — прод пишет в route_passport_ocr.
 *   Повтор до pending_total=0 (offset сдвигается мимо не скачавшихся PDF).
 *
 * Env: OCR_BASE (default https://vedarai.ru), CRON_SECRET, DRY_RUN=true|false,
 *      BATCH_LIMIT (1..5).
 */

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.OCR_BASE || 'https://vedarai.ru';
const SECRET = process.env.CRON_SECRET;
const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH = Math.min(Math.max(parseInt(process.env.BATCH_LIMIT || '3', 10) || 3, 1), 5);

if (!SECRET) { console.error('CRON_SECRET not set'); process.exit(1); }

const auth = { Authorization: `Bearer ${SECRET}` };

/** OpenDataLoader convert -> путь к .md; читаем markdown из выходной папки. */
async function pdfToMarkdown(convert, pdfPath, outDir) {
  await convert([pdfPath], { outputDir: outDir, format: ['markdown'] });
  const md = readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.md'));
  if (!md) throw new Error('OpenDataLoader не создал .md');
  return readFileSync(join(outDir, md), 'utf8');
}

async function main() {
  const { convert } = await import('@opendataloader/pdf');

  let totalOk = 0, totalErr = 0, offset = 0, pending = '?';
  for (let batch = 1; batch <= 200; batch++) {
    const res = await fetch(`${BASE}/api/cron/ocr-passports-pending?limit=${BATCH}&offset=${offset}`, { headers: auth });
    const data = await res.json().catch(() => null);
    if (!data?.success) { console.error(`партия ${batch}: pending упал:`, JSON.stringify(data)?.slice(0, 300)); process.exit(1); }
    pending = data.pending_total;
    if (!data.items.length) { console.log('пусто — выходим'); break; }

    let advanced = 0;
    for (const it of data.items) {
      if (it.error || !it.pdf_b64) {
        console.log(`  [skip] ${it.title}: ${it.error || 'нет pdf'}`);
        offset++; // не скачался — сдвигаемся мимо
        continue;
      }
      const dir = mkdtempSync(join(tmpdir(), 'odl-'));
      try {
        const pdfPath = join(dir, 'p.pdf');
        writeFileSync(pdfPath, Buffer.from(it.pdf_b64, 'base64'));
        const markdown = await pdfToMarkdown(convert, pdfPath, dir);
        const pages = (markdown.match(/\f/g)?.length ?? 0) + 1;
        if (DRY_RUN) {
          console.log(`  [dry] ${it.title}: ${markdown.length} симв`);
          offset++;
        } else {
          const w = await fetch(`${BASE}/api/cron/ocr-passports-write`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ route_id: it.route_id, markdown, pages }),
          });
          const wd = await w.json().catch(() => null);
          if (wd?.success) { console.log(`  [ok] ${it.title}: ${markdown.length} симв`); totalOk++; advanced++; }
          else { console.log(`  [write-err] ${it.title}: ${JSON.stringify(wd)?.slice(0, 200)}`); totalErr++; offset++; }
        }
      } catch (e) {
        console.log(`  [err] ${it.title}: ${e.message}`);
        totalErr++; offset++;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    console.log(`партия ${batch}: ok=${totalOk} err=${totalErr} pending=${pending}`);
    if (DRY_RUN) break;
    if (advanced === 0 && data.items.every((i) => i.error || !i.pdf_b64)) {
      // вся партия — нескачавшиеся, offset уже сдвинут; продолжаем
    }
    if (pending === 0) break;
  }
  console.log(`==================================================`);
  console.log(`ИТОГО: ok=${totalOk} err=${totalErr} pending=${pending} dry_run=${DRY_RUN}`);
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
