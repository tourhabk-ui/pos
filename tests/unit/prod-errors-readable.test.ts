/**
 * Прод-ошибки можно посмотреть списком, а не только «раз в сутки глазами агента».
 *
 * `instrumentation.onRequestError` пишет каждую серверную ошибку в
 * `ai_actions_log` давно. Но читал их только объектив эволюции, превращая в
 * находки раз в сутки. Посмотреть, что происходит прямо сейчас, было нельзя ни
 * владельцу, ни Claude в репозитории — и разговор об ошибках упирался в
 * ощущения вместо списка маршрутов со счётчиками.
 *
 * Здесь стерегутся три свойства читалки, каждое — из сегодняшних граблей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/prod-errors/route.ts'), 'utf-8');

describe('читалка ничего не меняет', () => {
  it('только чтение: ни одной пишущей команды', () => {
    // Находка — повод посмотреть, а не переписать данные. Роут, который может
    // писать, рано или поздно напишет.
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/);
  });
});

describe('сбой не выдаётся за пустоту', () => {
  it('упавший запрос отвечает ok: false и кодом 5xx', () => {
    // Ровно этой подменой /api/public/danger-summary молчал месяцами: catch
    // отдавал пустой список, неотличимый от «угроз нет».
    expect(SRC).toMatch(/ok:\s*false/);
    expect(SRC).toMatch(/status:\s*5\d\d/);
  });

  it('успех с нулём ошибок — тоже ответ, и он помечен ok: true', () => {
    expect(SRC).toMatch(/ok:\s*true/);
  });
});

describe('запрос защищён и ограничен', () => {
  it('закрыт CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/timingSafeCompare/);
    expect(SRC).toMatch(/status:\s*401/);
  });

  it('окно ограничено сверху — журнал действий пишется на каждый чих', () => {
    // Без потолка запрос «за месяц» превращается в полный скан таблицы,
    // которая растёт быстрее всех прочих.
    expect(SRC).toMatch(/Math\.min\(\s*168/);
  });

  it('параметры уходят значениями, а не в текст запроса', () => {
    expect(SRC).toMatch(/make_interval\(hours\s*=>\s*\$1\)/);
    expect(SRC).toMatch(/\$2::text IS NULL/);
    // Интерполяции в SQL-литерале быть не должно ни одной.
    const sql = SRC.slice(SRC.indexOf('`SELECT'), SRC.indexOf('LIMIT 50'));
    expect(sql).not.toMatch(/\$\{/);
  });
});
