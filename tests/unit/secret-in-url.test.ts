/**
 * Сторож: секрет крона не ездит в URL.
 *
 * ── Почему ───────────────────────────────────────────────────────────────
 *
 * Параметр `?secret=` оседает в access-логах nginx и Timeweb, в истории
 * планировщика и в выводе `curl -v`. Заголовок `Authorization` в логах не
 * пишется. `cronjob-sync.yml` уже ловил два джоба, у которых секрет уехал в
 * лог именно так.
 *
 * Перепись 01.09: 12 вызовов в 8 workflow несли секрет параметром, и
 * `/api/ai/debug-waterfall` принимал его только так. Все переведены на
 * заголовок; правило держит достигнутое.
 *
 * `getCronSecret` в `lib/auth/cron.ts` по-прежнему ЧИТАЕТ `?secret=` как
 * запасной путь — это осознанно: внешние планировщики (cron-job.org) вне
 * репозитория, и как они передают секрет, отсюда не видно (§4.0: «не знаю»).
 * Снимать запасной путь можно только после следа в данных, что внешние
 * вызовы идут заголовком. Здесь запрещается новое, а не ломается старое.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github', 'workflows');

function walk(dir: string, pred: (name: string) => boolean, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, pred, acc);
    else if (pred(e)) acc.push(p);
  }
  return acc;
}

describe('секрет крона — только заголовком', () => {
  it('ни один workflow не зовёт /api/... с ?secret= в URL', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x))) {
      const lines = readFileSync(join(WF_DIR, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('#')) return;
        if (/\/api\/[^"'\s]*\?secret=/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, 'секрет в URL попадёт в access-лог — передавайте -H "Authorization: Bearer $CRON_SECRET"').toEqual([]);
  });

  it('роуты не читают ?secret= сами — разбор только в lib/auth/cron.ts', () => {
    const files = walk(join(ROOT, 'app', 'api'), (n) => n === 'route.ts');
    const offenders = files
      .filter((f) => /searchParams\.get\(\s*['"]secret['"]\s*\)/.test(
        readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      ))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe('debug-waterfall закрыт', () => {
  const src = readFileSync(join(ROOT, 'app/api/ai/debug-waterfall/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('режима env без секрета больше нет', () => {
    // До 01.09: карта провайдеров + 12 символов ключа OpenRouter + длина —
    // без секрета, любому, кто знает адрес.
    expect(src).not.toMatch(/check['"]?\s*\)?\s*===\s*['"]env['"]/);
    expect(src).not.toMatch(/ACTIVE_OR_KEY_PREFIX|ACTIVE_OR_KEY_LENGTH|slice\(0,\s*12\)/);
  });

  it('секрет проверяется хелпером и только из заголовка', () => {
    expect(src).toMatch(/verifyCronSecret\(/);
    expect(src).toMatch(/headers\.get\(\s*['"]authorization['"]\s*\)/);
    expect(src).not.toMatch(/searchParams\.get\(\s*['"]secret['"]\s*\)/);
  });

  it('на проде без секрета — 404, не подсказка', () => {
    expect(src).toMatch(/NODE_ENV\s*===\s*['"]production['"][\s\S]{0,200}status:\s*404/);
  });
});
