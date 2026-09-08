/**
 * tests/unit/db-size-census.test.ts
 *
 * Перепись веса базы: числа вместо ощущения.
 *
 * 08.09 обсуждали, докупать ли ресурсы базе (1 CPU, 2 ГБ RAM, 20 ГБ NVMe,
 * 790 ₽/мес, автомасштабирование диска выключено). Решать оказалось нечем:
 * размер базы не мерил НИКТО — `pg_database_size` и `pg_total_relation_size`
 * не встречались в коде ни разу, и покупка делалась бы на глаз.
 *
 * Сторож держит три свойства переписи, каждое из которых — про честность:
 * она не выдумывает квоту тома (изнутри PostgreSQL та не видна), не выдаёт
 * оценку планировщика за точный счёт строк, и её отказ не выглядит как
 * «база пуста».
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const CENSUS = read('app/api/cron/db-size-census/route.ts');
/** Код без комментариев: судим запросы, а не рассказ о них в шапке. */
const code = CENSUS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('перепись меряет то, что обещает', () => {
  it('спрашивает размер базы и вес таблиц у самой базы', () => {
    expect(code).toMatch(/pg_database_size\(current_database\(\)\)/);
    expect(code).toMatch(/pg_total_relation_size\(c\.oid\)/);
    expect(code).toMatch(/pg_indexes_size\(c\.oid\)/);
  });

  it('журнальные таблицы названы поимённо — это кандидаты на выгрузку', () => {
    // Ни одна не участвует в брони, оплате или SOS: это наблюдение платформы
    // за собой, самое объёмное и самое холодное, что у нас есть.
    for (const t of ['agent_knowledge', 'agent_events', 'agent_effects', 'safety_decision_events']) {
      expect(code, `${t} не учтён среди растущих без чистки`).toContain(`'${t}'`);
    }
  });

  it('ничего не меняет: только SELECT', () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it('закрыта CRON_SECRET и сверяет его безопасно по времени', () => {
    expect(code).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('перепись не выдаёт догадку за факт (§4.0)', () => {
  it('квота тома не выдумывается: изнутри PostgreSQL её не видно', () => {
    // «Занято» знаем, «сколько дано» — нет. Процент заполнения здесь был бы
    // выдумкой, а по нему принимали бы решение о покупке.
    expect(code).toMatch(/disk_limit_mb:\s*null/);
    expect(code).toMatch(/disk_limit_note/);
    expect(code).not.toMatch(/20\s*\*\s*1024|20480|percent_full/);
  });

  it('оценка строк названа оценкой, а не счётом', () => {
    expect(code).toMatch(/n_live_tup/);
    expect(code).toMatch(/rows_estimate/);
    expect(code).toMatch(/rows_note/);
    // COUNT(*) по всем таблицам на боевой базе ради диагностики — не наш
    // путь. Ищем в САМИХ запросах: в пояснении к полю слова «не COUNT(*)»
    // законны, и первая редакция сторожа краснела именно на них.
    const queries = [...code.matchAll(/`([^`]*SELECT[^`]*)`/gi)].map(m => m[1]);
    expect(queries.length, 'запросы не найдены — сторож смотрит не туда').toBeGreaterThan(0);
    for (const q of queries) expect(q).not.toMatch(/COUNT\(\*\)/i);
  });

  it('ноль таблиц — отказ переписи, а не «база пуста»', () => {
    expect(code).toMatch(/meaningful:\s*tableRows\.length > 0/);
  });

  it('отказ запроса не молчит: SQLSTATE в лог, 503 наружу', () => {
    expect(code).toMatch(/SQLSTATE/);
    expect(code).toMatch(/status:\s*503/);
    expect(code).toMatch(/ok:\s*false/);
  });
});

describe('перепись объявлена', () => {
  it('в реестре планировщиков — молчание не ответ', () => {
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).toContain("'db-size-census'");
    // Только чтение — значит writes: false, и это должно быть записано.
    expect(reg).toMatch(/'db-size-census':\s*\{ kind: 'manual', writes: false/);
  });
});
