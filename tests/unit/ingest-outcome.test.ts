/**
 * Ноль вставок должен читаться однозначно.
 *
 * Разбор #883: канал ВК выглядел мёртвым (`events_found: 32`, `inserted: 0`),
 * а на деле работал — строки за минуты до того положил внутренний heartbeat.
 * Ноль означал «всё уже здесь», читался как «канал МЧС молчит», и стоил
 * полного расследования.
 *
 * Фикстуры ниже — ровно те три состояния, которые раньше сливались в одно
 * число: первый удачный ingest, второй идемпотентный прогон и источник,
 * которого этот наблюдатель намеренно не касался. Плюс граница, которая на
 * слое безопасности дороже прочих: упавший источник не должен выглядеть тихим.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ingestOutcome,
  sourceReport,
  OUTCOME_LABEL,
  TRIGGER_LABEL,
  type IngestOutcome,
} from '@/lib/services/safety/ingest-outcome';

/** Прогон, где источник впервые принёс события и они записались. */
const FIRST_RUN = {
  result: { events: new Array(35).fill(0), inserted: 35, skipped: 0, errors: [], rawItems: 25 },
  requiresEnv: 'VK_SERVICE_TOKEN',
  envValue: 'token',
};

/** Тот же источник минутами позже: всё уже в базе. Это здоровье, не поломка. */
const IDEMPOTENT_RUN = {
  result: { events: new Array(35).fill(0), inserted: 0, skipped: 35, errors: [], rawItems: 25 },
  requiresEnv: 'VK_SERVICE_TOKEN',
  envValue: 'token',
};

/** Наблюдатель к источнику не ходил — про канал это не говорит ничего. */
const NOT_FETCHED = { result: undefined, requiresEnv: undefined, envValue: undefined };

describe('первый удачный ingest', () => {
  it('исход — inserted', () => {
    expect(ingestOutcome(FIRST_RUN)).toBe('inserted');
  });

  it('в отчёте видно и сырые посты, и классифицированные события', () => {
    const r = sourceReport(FIRST_RUN);
    expect(r.fetched).toBe(true);
    expect(r.raw_items).toBe(25);
    expect(r.classified).toBe(35);
    expect(r.inserted).toBe(35);
    expect(r.skipped_conflict).toBe(0);
  });
});

describe('второй, идемпотентный прогон — тот самый случай #883', () => {
  it('исход — classified_but_not_inserted, а не «пусто» и не ошибка', () => {
    expect(ingestOutcome(IDEMPOTENT_RUN)).toBe('classified_but_not_inserted');
  });

  it('отличается от первого прогона ТОЛЬКО распределением вставок', () => {
    const first = sourceReport(FIRST_RUN);
    const second = sourceReport(IDEMPOTENT_RUN);
    // Канал в обоих случаях одинаково живой: те же 25 постов, те же 35 событий.
    expect(second.fetched).toBe(first.fetched);
    expect(second.raw_items).toBe(first.raw_items);
    expect(second.classified).toBe(first.classified);
    // Разница только здесь — и теперь она названа словом, а не нулём.
    expect(second.inserted).toBe(0);
    expect(second.skipped_conflict).toBe(35);
    expect(second.outcome).not.toBe(first.outcome);
  });

  it('пояснение не даёт прочитать это как поломку', () => {
    const r = sourceReport(IDEMPOTENT_RUN);
    expect(r.outcome_label).toMatch(/уже в базе/);
  });
});

describe('источник, который этот прогон не опрашивал', () => {
  it('исход — not_fetched', () => {
    expect(ingestOutcome(NOT_FETCHED)).toBe('not_fetched');
  });

  it('not_fetched говорит про наблюдателя, а не про здоровье канала', () => {
    const r = sourceReport(NOT_FETCHED);
    expect(r.fetched).toBe(false);
    // Ни одного числа, которое можно принять за «канал ничего не дал»:
    // счётчики нулевые именно потому, что мы туда не ходили.
    expect(r.raw_items).toBeNull();
    expect(r.classified).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.outcome_label).toMatch(/не опрашивал/);
  });

  it('не путается с «источник не подключён»', () => {
    const noKey = ingestOutcome({ result: undefined, requiresEnv: 'VK_SERVICE_TOKEN', envValue: undefined });
    expect(noKey).toBe('not_configured');
    expect(noKey).not.toBe('not_fetched');
  });
});

describe('границы, которые дороже прочих', () => {
  it('упавший источник не выглядит тихим', () => {
    // Молча показать сбой как пустоту — та же ложь, что зелёная точка у
    // недоступных данных на главной.
    const failed = { result: { events: [], inserted: 0, skipped: 0, errors: ['vk http 500'], rawItems: 0 } };
    expect(ingestOutcome(failed)).toBe('fetch_failed');
  });

  it('частичный сбой при удачных вставках остаётся inserted, ошибки не теряются', () => {
    const partial = { result: { events: [1], inserted: 1, skipped: 0, errors: ['одна запись упала'], rawItems: 3 } };
    expect(ingestOutcome(partial)).toBe('inserted');
    expect(sourceReport(partial).errors).toEqual(['одна запись упала']);
  });

  it('«постов не дали» и «дали, но угроз нет» — разные исходы', () => {
    const empty = { result: { events: [], inserted: 0, skipped: 0, errors: [], rawItems: 0 } };
    const allFiltered = { result: { events: [], inserted: 0, skipped: 0, errors: [], rawItems: 12 } };
    expect(ingestOutcome(empty)).toBe('fetched_zero');
    expect(ingestOutcome(allFiltered)).toBe('fetched_nothing_relevant');
  });

  it('источник без счётчика сырых постов не выдумывает его', () => {
    const noRaw = { result: { events: [], inserted: 0, skipped: 0, errors: [] } };
    expect(ingestOutcome(noRaw)).toBe('fetched_zero');
    expect(sourceReport(noRaw).raw_items).toBeNull();
  });
});

describe('отчёт эндпоинта называет наблюдателя', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
  /** Комментарии цитируют имена триггеров — сверять надо код. */
  const CODE = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('оба прогона помечают себя, и метки разные', () => {
    const triggers = [...CODE.matchAll(/buildResponse\([^)]*?,\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]);
    // Две ветки — heartbeat и воркфлоу. Одинаковая метка вернула бы ровно ту
    // слепоту, из-за которой разбирали #883.
    expect(triggers).toHaveLength(2);
    expect(new Set(triggers).size).toBe(2);
  });

  it('в ответ уходит разбор по источникам', () => {
    expect(CODE).toMatch(/sourceReport\(/);
    expect(CODE).toMatch(/\bsources,/);
    expect(CODE).toMatch(/trigger_label/);
  });

  it('логика здоровья источников не тронута', () => {
    // Правка — про наблюдаемость. Если outcome просочится в entryFor, статусы
    // watchdog поедут, и «не опрашивали» может стать ложным «канал мёртв».
    const entryFor = CODE.slice(CODE.indexOf('function entryFor'), CODE.indexOf('async function watchSourceHealth'));
    expect(entryFor).not.toMatch(/ingestOutcome|sourceReport/);
  });
});

describe('словарь исходов полон', () => {
  it('у каждого исхода есть пояснение', () => {
    const all: IngestOutcome[] = [
      'not_configured', 'not_fetched', 'fetched_zero', 'fetched_nothing_relevant',
      'classified_but_not_inserted', 'inserted', 'fetch_failed',
    ];
    for (const o of all) expect(OUTCOME_LABEL[o], `нет подписи для ${o}`).toBeTruthy();
    expect(Object.keys(OUTCOME_LABEL).sort()).toEqual([...all].sort());
  });

  it('оба планировщика названы — иначе отчёт нечитаем', () => {
    expect(TRIGGER_LABEL.heartbeat_get).toMatch(/start\.js/);
    expect(TRIGGER_LABEL.workflow_post).toMatch(/GitHub Actions/);
  });
});
