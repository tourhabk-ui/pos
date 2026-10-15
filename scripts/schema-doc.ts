#!/usr/bin/env tsx
/**
 * scripts/schema-doc.ts — шаги job `.github/workflows/db-schema-doc.yml`,
 * которым нужно правило, а не shell.
 *
 *   npx tsx scripts/schema-doc.ts check                  отстал ли справочник от migrations/
 *   npx tsx scripts/schema-doc.ts reset-after-baseline   снять отметки новее baseline (нужен DATABASE_URL)
 *   npx tsx scripts/schema-doc.ts stamp                  имя миграции из шапки — для сообщения коммита
 *
 * Аудит 15.10 (AR-schema-doc): справочник снимается после влития, а не в
 * каждом PR. Правило свежести живёт в `lib/database/schema-doc-freshness.ts`,
 * чтобы job и сторож судили одним предикатом. Граница baseline — строка шапки
 * самого снимка («Последняя миграция в снимке:», разбор —
 * `lib/database/baseline-header.ts`), та же, что у шаблона pg-тестов: не
 * число в workflow и не вторая константа рядом.
 *
 * `check` пишет `stale=true|false` в `$GITHUB_OUTPUT`. «Не знаю» (нет файла,
 * нет подписи) — это `stale=true`: лекарство от сломанной шапки то же, что
 * от отставшей, — снять заново. Код выхода не 0 — только когда не прочитался
 * сам каталог миграций: тогда судить нечем, и job обязан покраснеть.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parseBaselineHeader } from '../lib/database/baseline-header';
import {
  changesSchema,
  judgeFreshness,
  resetAfterBaseline,
  snapshotMigration,
} from '../lib/database/schema-doc-freshness';

const ROOT = process.cwd();
const DOC = join(ROOT, 'docs', 'DB_SCHEMA.md');
const MIGRATIONS = join(ROOT, 'migrations');
const BASELINE = join(ROOT, 'lib', 'database', 'baseline', 'schema-baseline.sql');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    // Не глушим: имя файла и причина — в лог; решение «что с этим делать»
    // принимает вызывающий по `null`.
    console.error(`не прочитан ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function setOutput(name: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${name}=${value}\n`);
}

function check(): void {
  const files = migrationFiles();
  const verdict = judgeFreshness(readOrNull(DOC), files, (f) => changesSchema(readOrNull(join(MIGRATIONS, f))));
  switch (verdict.state) {
    case 'fresh':
      console.log(`Справочник снят с ${verdict.snapshot}; схемных миграций новее нет — снимать нечего.`);
      setOutput('stale', 'false');
      return;
    case 'stale':
      console.log(
        `Справочник снят с ${verdict.snapshot}${verdict.missing ? ' (такого файла в migrations/ уже нет)' : ''}; ` +
          `схемных миграций новее: ${verdict.lag.length}${verdict.lag.length ? ` — ${verdict.lag.join(', ')}` : ''}.`,
      );
      setOutput('stale', 'true');
      return;
    case 'unknown':
      console.log(`Судить не по чему: ${verdict.reason}. Снимаю заново.`);
      setOutput('stale', 'true');
      return;
  }
}

async function reset(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан — отметки снимать не с чего');
  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  // Граница — из шапки baseline. Строки нет — стоп: снимать отметки по
  // выдуманной границе значит подписать справочник чужой схемой (§4.0).
  const firstAfter = parseBaselineHeader(readFileSync(BASELINE, 'utf-8')).firstAfter;
  if (firstAfter === null) {
    throw new Error('в шапке baseline нет строки «-- Последняя миграция в снимке: NNN_имя.sql» — граница не установлена');
  }
  await client.connect();
  try {
    const reset = await resetAfterBaseline(client, migrationFiles(), firstAfter);
    console.log(
      `Снято отметок новее baseline (с ${firstAfter}): ${reset.length}, ` +
        `от ${reset[0]} до ${reset[reset.length - 1]}.`,
    );
  } finally {
    await client.end();
  }
}

function stamp(): void {
  const doc = readOrNull(DOC);
  const name = doc === null ? null : snapshotMigration(doc);
  if (name === null) throw new Error('в docs/DB_SCHEMA.md нет подписи последней миграции');
  process.stdout.write(`${name}\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'check') return check();
  if (cmd === 'reset-after-baseline') return reset();
  if (cmd === 'stamp') return stamp();
  throw new Error(`неизвестная команда «${cmd ?? ''}»: check | reset-after-baseline | stamp`);
}

main().catch((e: unknown) => {
  console.error(`::error::schema-doc: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
