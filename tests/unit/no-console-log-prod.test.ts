/**
 * Детерминированный сторож: `console.log` вне request-path (CLAUDE.md §4).
 *
 * eslint.config.mjs выключает `no-console` НАМЕРЕННО с комментарием, что запрет
 * живёт «отдельным детерминированным сторожем в тестах, а не правилом линтера,
 * который в CI не гоняется». Аудит 01.08 обнаружил: сторожа этого не
 * существовало — правило было продекларировано, но не enforced. Этот файл его
 * реализует, чтобы комментарий перестал врать.
 *
 * Принцип §4: `console.log` запрещён в ПРОД-коде (request-path — app/, lib/,
 * components/). В коде он либо не нужен, либо должен быть `console.error` в
 * catch. CLI-раннеры (мигратор, скрипты) — не request-path: их работа и есть
 * печать прогресса в stdout, и `console.error` там был бы враньём (прогресс —
 * не ошибка). Такие файлы в ALLOWLIST с обоснованием, а не выпадают случайно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Осознанные исключения: CLI-раннеры, чья работа — печать прогресса в stdout.
 * Каждая запись — не «забыли починить», а «здесь console.log уместен».
 */
const ALLOWLIST = new Set<string>([
  // CLI-мигратор: `npx tsx lib/database/migrate.ts` / `npm run migrate`.
  // Печатает [SCAN]/[APPLY]/[SUMMARY] в stdout — это его интерфейс, не
  // request-path. console.error исказил бы прогресс в поток ошибок.
  'lib/database/migrate.ts',
]);

/** Все .ts/.tsx в прод-периметре, кроме тестов, через git ls-files (без node_modules). */
function prodFiles(): string[] {
  const out = execSync('git ls-files "app/*.ts" "app/*.tsx" "lib/*.ts" "lib/*.tsx" "components/*.tsx" "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts" "lib/**/*.tsx" "components/**/*.tsx"', { encoding: 'utf-8' });
  return [...new Set(out.split('\n').filter(Boolean))]
    .filter((f) => !f.includes('.test.') && !f.includes('__tests__'));
}

/** Строки с console.log вне комментариев. */
function consoleLogLines(src: string): number[] {
  const lines: number[] = [];
  src.split('\n').forEach((line, i) => {
    const ls = line.trim();
    if (ls.startsWith('//') || ls.startsWith('*') || ls.startsWith('/*')) return;
    if (/\bconsole\.log\s*\(/.test(line)) lines.push(i + 1);
  });
  return lines;
}

describe('console.log вне request-path запрещён (§4)', () => {
  const files = prodFiles();

  it('периметр вообще собрался — иначе сторож молчит впустую', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('ни один прод-файл вне allowlist не печатает console.log', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWLIST.has(f)) continue;
      const hits = consoleLogLines(readFileSync(join(process.cwd(), f), 'utf-8'));
      if (hits.length) offenders.push(`${f}:${hits.join(',')}`);
    }
    expect(offenders, `console.log в прод-коде — используйте console.error в catch или уберите:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('allowlist не протух: каждый файл существует и реально содержит console.log', () => {
    // Мёртвая запись в allowlist маскировала бы будущее нарушение с тем же путём.
    for (const f of ALLOWLIST) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      expect(consoleLogLines(src).length, `${f} в allowlist, но console.log в нём нет — запись пора убрать`)
        .toBeGreaterThan(0);
    }
  });
});
