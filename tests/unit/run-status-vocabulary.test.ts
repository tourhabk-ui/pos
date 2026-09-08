/**
 * Статус прогона, которого не бывает, — это вечный ноль на дашборде.
 *
 * Находка аудита 08.09 (прогон 6): брифинг агентов и админский «мозг»
 * считали «ошибок за 24 часа» условием `status = 'error'`. Такого статуса
 * не пишет НИКТО: прогон кончается `success`, `partial` или `failed`.
 * Цифра была вечным нулём и читалась как «ошибок нет».
 *
 * Болезнь не новая — та же уже описана в feedback-loop, где «Исправлено» на
 * дашборде было вечным нулём по той же причине. Значит лечить надо не
 * случай, а класс: любой SQL-литерал статуса рядом с `agent_run_history`
 * обязан входить в единственный словарь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RUN_STATUSES, RUN_STATUSES_BAD } from '@/lib/agents/run-logger';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Литералы статуса в одном SQL-куске. Чистая — проверяется на образце. */
export function statusLiteralsInSql(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/(?:WHERE|AND|OR)\s+status\s*(?:=|<>|!=)\s*'([a-z_]+)'/gi)) {
    out.push(m[1]);
  }
  for (const m of sql.matchAll(/(?:WHERE|AND|OR)\s+status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)) {
    for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) out.push(lit[1]);
  }
  return out;
}

/**
 * Литералы статуса ВНУТРИ запросов к истории прогонов.
 *
 * Разбор идёт по отдельным SQL-строкам, а не по файлу целиком: в одном файле
 * живут запросы к разным таблицам, и у каждой свой словарь статусов — у
 * находок эволюции open/suggested/rejected, у платежей HELD, у SOS
 * resolved/false_alarm. Сторож, глядящий на файл, объявил бы нарушением их
 * все и был бы отключён на второй день.
 */
function statusLiteralsNearRunHistory(): Array<{ file: string; literal: string }> {
  const found: Array<{ file: string; literal: string }> = [];
  for (const dir of ['lib', 'app']) {
    for (const file of walk(join(ROOT, dir))) {
      const code = readFileSync(file, 'utf-8');
      if (!code.includes('agent_run_history')) continue;
      const rel = relative(ROOT, file).split('\\').join('/');
      // Каждая шаблонная строка — отдельный запрос.
      for (const block of code.match(/`[^`]*`/g) ?? []) {
        if (!block.includes('agent_run_history')) continue;
        for (const literal of statusLiteralsInSql(block)) found.push({ file: rel, literal });
      }
    }
  }
  return found;
}

describe('словарь статусов прогона — один', () => {
  it('словарь непустой и содержит то, что пишет логгер', () => {
    expect([...RUN_STATUSES].sort()).toEqual(['failed', 'partial', 'success']);
    expect([...RUN_STATUSES_BAD].sort()).toEqual(['failed', 'partial']);
  });

  it('«не успех» не равен «провал»: partial тоже считается ошибкой', () => {
    // Иначе прогон, который сходил и ничего не довёл, числился бы удачным.
    expect(RUN_STATUSES_BAD).toContain('partial');
  });

  it('в запросах к истории прогонов нет статусов вне словаря', () => {
    const bad = statusLiteralsNearRunHistory().filter(
      (x) => !(RUN_STATUSES as readonly string[]).includes(x.literal),
    );
    const names = bad.map((x) => `${x.file}: '${x.literal}'`);
    expect(
      names,
      `такой статус не пишет никто — счётчик будет вечным нулём: ${names.join(', ')}`,
    ).toEqual([]);
  });

  it('счётчики ошибок действительно нашлись — сторож не охраняет пустоту', () => {
    const all = statusLiteralsNearRunHistory();
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('сторож поймал бы исходный дефект', () => {
  // Без этой проверки нельзя утверждать, что он вообще что-то ловит.
  const HISTORICAL = `
    SELECT COUNT(*)::text FROM agent_run_history
     WHERE status = 'error' AND started_at > NOW() - INTERVAL '24h'
  `;

  it('видит фантомный статус в исторической форме запроса', () => {
    const lits = statusLiteralsInSql(HISTORICAL);
    expect(lits).toContain('error');
    expect(lits.every((l) => (RUN_STATUSES as readonly string[]).includes(l))).toBe(false);
  });

  it('починенную форму пропускает', () => {
    const fixed = `
      SELECT COUNT(*)::text FROM agent_run_history
       WHERE status IN ('failed', 'partial') AND started_at > NOW() - INTERVAL '24h'
    `;
    const lits = statusLiteralsInSql(fixed);
    expect(lits.sort()).toEqual(['failed', 'partial']);
    expect(lits.every((l) => (RUN_STATUSES as readonly string[]).includes(l))).toBe(true);
  });

  it('присваивание в TypeScript под правило не подпадает', () => {
    // У статуса ИСТОЧНИКА безопасности свой словарь; сторож, ловящий слово
    // вместо конструкции, шумел бы и был бы отключён целиком.
    expect(statusLiteralsInSql("status = 'not_configured';")).toEqual([]);
  });
});
