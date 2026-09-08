/**
 * scripts/cron-capability-census.ts — снять перепись возможностей крон-роутов.
 *
 *   npx tsx scripts/cron-capability-census.ts          # таблица для человека
 *   npx tsx scripts/cron-capability-census.ts --freeze # готовый реестр в stdout
 *
 * Перепись СНИМАЕТСЯ скриптом, а замораживается руками: сгенерированный
 * реестр коммитится и дальше служит эталоном. Тот же приём, что у
 * `UNDECLARED_TABLES` и у реестра LLM-хостов, и по той же причине — запретить
 * рост беды дешевле, чем разом убрать накопленное.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanCapabilities, type Capability } from '../lib/agents/cron-capabilities';

const ROOT = process.cwd();

/**
 * Прочитать файл или честно вернуть null.
 *
 * Без `existsSync` перед чтением намеренно: пара «проверил — прочитал» это
 * гонка (файл мог измениться между двумя вызовами), и CodeQL справедливо
 * помечает её. Попытка чтения отвечает на тот же вопрос одним действием и
 * без окна между проверкой и делом.
 */
function tryRead(relPath: string): string | null {
  try {
    return readFileSync(join(ROOT, relPath), 'utf-8');
  } catch {
    // Файла нет или он не читается — для переписи это одно и то же «не смогли
    // посмотреть», и оно уедет в `unexplored` вызывающего, а не в «умений нет».
    return null;
  }
}

/** Читатель модулей по id вида `lib/foo/bar` — с обычными расширениями. */
export function makeReader(): (id: string) => string | null {
  const cache = new Map<string, string | null>();
  return (id: string) => {
    if (cache.has(id)) return cache.get(id) ?? null;
    let out: string | null = null;
    for (const c of [`${id}.ts`, `${id}.tsx`, join(id, 'index.ts'), join(id, 'index.tsx')]) {
      out = tryRead(c);
      if (out !== null) break;
    }
    cache.set(id, out);
    return out;
  };
}

/** Все крон-эндпоинты: имя каталога → id модуля роута. */
export function cronRoutes(): Array<{ key: string; moduleId: string }> {
  const dir = join(ROOT, 'app', 'api', 'cron');
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ key: e.name, moduleId: `app/api/cron/${e.name}/route` }))
    .filter(r => tryRead(`${r.moduleId}.ts`) !== null)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function main(): void {
  const freeze = process.argv.includes('--freeze');
  const read = makeReader();
  const rows = cronRoutes().map(r => ({ key: r.key, ...scanCapabilities(r.moduleId, read) }));

  if (freeze) {
    const body = rows
      .map(r => `  '${r.key}': [${r.capabilities.map((c: Capability) => `'${c}'`).join(', ')}],`)
      .join('\n');
    process.stdout.write(`export const CRON_CAPABILITIES: Record<string, readonly Capability[]> = {\n${body}\n};\n`);
    return;
  }

  const withUnexplored = rows.filter(r => r.unexplored.length > 0);
  process.stdout.write(`Крон-роутов: ${rows.length}\n\n`);
  for (const cap of ['money', 'pd_direct', 'telegram', 'ai', 'db_write', 'net_out', 'db_read'] as Capability[]) {
    const n = rows.filter(r => r.capabilities.includes(cap)).length;
    process.stdout.write(`  ${cap.padEnd(9)} ${String(n).padStart(4)}\n`);
  }
  process.stdout.write(`\nС недосмотренными модулями (перечень неполон): ${withUnexplored.length}\n`);
  for (const r of rows) {
    process.stdout.write(`${r.key.padEnd(34)} ${r.capabilities.join(',') || '—'}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('cron-capability-census.ts')) main();
