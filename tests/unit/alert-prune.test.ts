/**
 * Жанровые стражи чистят и то, что уже лежит в базе.
 *
 * Перепись 11.08: 137 маршрутов из 421 стояли «Не сегодня», и причина у всех
 * одна — «На Камчатке сводная группировка спасателей обеспечила безопасность
 * туристической группы». Репортаж о законченной работе, а не предупреждение.
 *
 * Страж этот глагол ЗНАЕТ: новая такая запись до базы не дойдёт. Но эта попала
 * раньше него, а ручная чистка (миграция 846) шла своим списком глаголов на
 * SQL и до «обеспечила безопасность» не доросла. Два списка об одном правиле
 * разошлись — и треть справочника красилась из-за расхождения копий.
 *
 * Поэтому здесь проверяется не текст регулярки, а поведение: сегодняшний
 * страж применяется к хранилищу, и список глаголов остаётся один.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rejectedGenre, pruneRejectedGenres, type QueryFn } from '@/lib/services/safety/alert-prune';

/** Та самая запись с прода, из-за которой стоял запрет. */
const SURVIVOR = 'На Камчатке сводная группировка спасателей обеспечила безопасность туристической группы';
/** Суточная сводка — второй отбракованный жанр. */
const BULLETIN = 'На контроле ЦУКС ГУ МЧС России по Камчатскому краю по состоянию на 06.00';
/** Настоящее предупреждение: его трогать нельзя. */
const CYCLONE = 'Экстренное предупреждение: циклон, очень сильный дождь, тургруппам воздержаться от выхода на маршруты';

describe('что отбраковывается сегодняшним стражем', () => {
  it('запись, пережившая ручную чистку, отбраковывается', () => {
    expect(rejectedGenre(SURVIVOR)).toBe('rescue_report');
  });

  it('суточная сводка отбраковывается', () => {
    expect(rejectedGenre(BULLETIN)).toBe('daily_bulletin');
  });

  it('настоящее предупреждение остаётся', () => {
    // Ошибка в эту сторону дороже: снять предупреждение о циклоне — это
    // не «чуть меньше красного», это молчание перед опасностью.
    expect(rejectedGenre(CYCLONE)).toBeNull();
  });

  it('слово «спасатели» само по себе не приговор', () => {
    expect(rejectedGenre('Спасатели рекомендуют туристам воздержаться от выхода: ожидается циклон')).toBeNull();
  });
});

/** Мини-имитация БД: помнит, что удалили и чем обновляли. */
function fakeDb(rows: Array<{ id: string; title: string | null; description: string | null }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: QueryFn = async <T,>(sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT[\s\S]*external_alerts/i.test(sql)) return { rows: rows as T[] };
    if (/UPDATE location_real_time_status/i.test(sql)) return { rows: [{ id: 'p1' }] as T[] };
    return { rows: [] as T[] };
  };
  return { q, calls };
}

describe('чистка хранилища', () => {
  const rows = [
    { id: 'a1', title: SURVIVOR, description: null },
    { id: 'a2', title: BULLETIN, description: null },
    { id: 'a3', title: CYCLONE, description: 'Ожидается усиление ветра' },
  ];

  it('снимает отбракованное и не трогает предупреждение', async () => {
    const { q, calls } = fakeDb(rows);
    const r = await pruneRejectedGenres(q);
    expect(r.checked).toBe(3);
    expect(r.removed).toBe(2);
    expect(r.by_genre).toEqual({ daily_bulletin: 1, rescue_report: 1 });

    const del = calls.find((c) => /DELETE FROM external_alerts/i.test(c.sql));
    expect(del).toBeDefined();
    expect(del!.params[0]).toEqual(['a1', 'a2']);
  });

  it('снимает тот же текст и с карточек точек', async () => {
    // Иначе запись исчезнет из источника и останется на экранах — ровно на
    // это напоролась миграция 846.
    const { q, calls } = fakeDb(rows);
    const r = await pruneRejectedGenres(q);
    const upd = calls.find((c) => /UPDATE location_real_time_status/i.test(c.sql));
    expect(upd).toBeDefined();
    expect(upd!.params[0]).toEqual([SURVIVOR, BULLETIN]);
    expect(r.places_cleaned).toBe(1);
  });

  it('чисто — значит ноль, а не «не проверяли»', async () => {
    const { q, calls } = fakeDb([{ id: 'a3', title: CYCLONE, description: null }]);
    const r = await pruneRejectedGenres(q);
    expect(r.removed).toBe(0);
    expect(r.checked).toBe(1);
    expect(calls.some((c) => /DELETE/i.test(c.sql))).toBe(false);
  });

  it('жанр виден по телу, а не только по заголовку', async () => {
    // Глагол операции нередко стоит во второй фразе, а не в шапке.
    const { q } = fakeDb([
      { id: 'b1', title: 'Происшествие в Налычево', description: 'Спасатели эвакуировали группу из четырёх человек' },
    ]);
    expect((await pruneRejectedGenres(q)).removed).toBe(1);
  });

  it('пустая запись не считается отбракованной', async () => {
    const { q } = fakeDb([{ id: 'c1', title: null, description: null }]);
    const r = await pruneRejectedGenres(q);
    expect(r.removed).toBe(0);
  });
});

describe('правило остаётся одно', () => {
  it('чистка зовёт те же функции стража, а не свой список глаголов', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/alert-prune.ts'), 'utf-8');
    expect(src).toMatch(/from '@\/lib\/services\/safety\/seismic-parser'/);
    // Своих глаголов операции тут быть не должно: копия разойдётся так же,
    // как разошлась SQL-копия в миграции 846.
    expect(src).not.toMatch(/обеспечил\[/);
    expect(src).not.toMatch(/эвакуирова\|/);
  });

  it('удаление не утверждает, какого типа ключ', () => {
    // Здесь стояло `id = ANY($1::uuid[])`, а ключ `external_alerts` —
    // BIGSERIAL (миграция 070). Postgres отвечал «operator does not exist:
    // bigint = uuid», и удаление не срабатывало НИ РАЗУ: пока протухших
    // записей не было, ветка не исполнялась, а первая же уронила весь приём.
    //
    // Мок в тестах выше SQL не исполняет — он и не мог этого поймать.
    // Поэтому здесь проверяется сам текст запроса, и проверяется не «uuid
    // это или bigint», а то, что код вообще не берётся судить о типе:
    // идентификаторы пришли из SELECT строками, строками и сравниваются.
    // Утверждение о типе — это то, что уже один раз оказалось ложным.
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/alert-prune.ts'), 'utf-8');
    const del = src.match(/DELETE FROM external_alerts[^`]*/)?.[0] ?? '';
    expect(del).not.toBe('');
    expect(del).toMatch(/id::text = ANY\(\$1::text\[\]\)/);
    expect(del).not.toMatch(/::uuid|::bigint|::int/);
  });

  it('крон приёма применяет чистку до пересборки статуса точек', () => {
    // Если чистить ПОСЛЕ, пересборка разложит отбракованное по точкам заново.
    const cron = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
    expect(cron).toMatch(/pruneRejectedGenres\([\s\S]{0,200}updateRealTimeStatus\(\)/);
  });
});

/**
 * Уборка не имеет права убивать приём.
 *
 * Тревога 14.08: «сейсмо-ингест молчит 3805 минут» при SLA в пять. Приём при
 * этом мог отработать — heartbeat пишется НИЖЕ по коду, и любое падение между
 * приёмом и записью стирает не данные, а СВИДЕТЕЛЬСТВО того, что приём был.
 * Монитор видит тишину и объявляет молчание.
 *
 * Сейсмика — безопасность людей, чистка жанров — гигиена витрины. Когда
 * второе роняет первое, порядок важности перевёрнут.
 */
describe('чистка жанров не может уронить сейсмо-приём', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8',
  ) as string;

  it('вызов обёрнут, а не голый await', () => {
    // Голый `await pruneRejectedGenres(query)` был единственным незащищённым
    // шагом в роуте: ingestAll и updateRealTimeStatus ловят своё внутри.
    expect(src).not.toMatch(/const pruned = await pruneRejectedGenres\(/);
    expect(src).toMatch(/safely\('prune'/);
  });

  it('обёртка возвращает причину, а не глотает ошибку', () => {
    // Молча проглоченная ошибка означала бы, что чистка перестанет работать
    // незаметно — тот же класс подмены, только в другую сторону.
    expect(src).toMatch(/return \{ error: `\$\{step\}/);
    expect(src).toMatch(/'error' in pruned \? \[pruned\.error\]/);
  });

  it('оба входа роута защищены, а не только один', () => {
    // GET дёргает супервизор start.js, POST — воркфлоу. Защита одного входа
    // оставила бы второй с прежним дефектом: одно правило в двух местах.
    expect(src.match(/safely\('prune'/g)?.length).toBe(2);
  });
});
