#!/usr/bin/env node
/**
 * Мутации списком: сломать правило в одном месте, прогнать тест, вернуть файл.
 * Одна строка на мутацию — RED (тест поймал), GREEN(!) (не поймал),
 * NO-MATCH (строки в файле нет). Полный вывод теста — в лог, не в консоль.
 *
 * Зачем скриптом: раньше каждая мутация — отдельный вызов модели с полным
 * выводом vitest (статья arXiv 2611.10022: механические шаги дешевле
 * программой, модель — только для суждения; слово владельца 20.11).
 *
 *   node scripts/session/mutate.mjs list.json
 *   list.json: [{ "name", "file", "old", "new", "test" }] или "cmd": [...]
 *
 * Файл возвращается всегда — и при падении теста, и при Ctrl+C.
 * Код выхода 1, если есть GREEN(!) или NO-MATCH.
 */
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Одна мутация. `run(cmd)` — исполнитель, подменяемый в тесте. */
export function mutateOnce(m, run) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.old)) return { name: m.name, verdict: 'NO-MATCH', detail: '' };
  let restored = false;
  const restore = () => {
    if (!restored) { writeFileSync(m.file, original); restored = true; }
  };
  const onSignal = () => { restore(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    writeFileSync(m.file, original.replace(m.old, m.new));
    const cmd = Array.isArray(m.cmd) && m.cmd.length > 0 ? m.cmd : ['npx', 'vitest', 'run', m.test];
    const r = run(cmd);
    const failed = /Tests\s+(\d+ failed[^\n]*)/.exec(r.output)?.[1] ?? '';
    return { name: m.name, verdict: r.status === 0 ? 'GREEN(!)' : 'RED', detail: failed, output: r.output };
  } finally {
    restore();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function spawnRun(cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main() {
  const listPath = process.argv[2];
  if (!listPath) {
    console.error('Нужен список мутаций: node scripts/session/mutate.mjs list.json');
    process.exit(2);
  }
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  const log = join(mkdtempSync(join(tmpdir(), 'mutate-')), 'mutate.log');
  let bad = 0;
  for (const m of list) {
    const res = mutateOnce(m, spawnRun);
    if (res.verdict !== 'RED') bad += 1;
    appendFileSync(log, `=== ${res.name}: ${res.verdict}\n${res.output ?? ''}\n`);
    console.log(`${res.verdict.padEnd(9)} ${res.name}${res.detail ? ` — ${res.detail}` : ''}`);
  }
  console.log(`итог: ${list.length - bad} из ${list.length} пойманы; лог ${log}`);
  process.exit(bad > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
