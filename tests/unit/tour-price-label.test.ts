/**
 * Сторож цены тура: «не знаю» не превращается в ноль, а цена — в «от».
 *
 * 18.09, каталог с прода (MCP `get_tours`):
 *
 *   ID34 «Сплав по реке Быстрая (три дня)» — от 0 р/чел
 *
 * Нуля в базе нет и быть не может: у `operator_tours.base_price` стоит CHECK
 * `base_price > 0`, а колонка NULLABLE. То есть у тура цена НЕ ЗАПИСАНА, а
 * ноль родил формат — `Number(null)` это `0`.
 *
 * 17.11 (#3487): у тура цена одна — `base_price`, и «от» перед ней выдумано:
 * меньше этой суммы тур не стоит ни при каком составе, и «от 97 000 ₽»
 * читалось как «бывает дешевле». Карточка писала «97 000 ₽», MCP — «от 97 000
 * ₽/чел.». Теперь цена тура печатается одной функцией без «от»
 * (`priceWithUnitWords`); законное «от» остаётся у перевозчика и минимума
 * планера — у них это правда.
 *
 * Сторож судит вызовом: строки исходника проверяются только запретами.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRICE_UNIT_NOT_RECORDED, priceSum, priceUnitKnown, priceUnitWords, priceWithUnitWords, priceWithUnitWordsOrSay,
} from '@/lib/tours/price-label';
import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';
import { handleAliceTours, type FetchTours } from '@/lib/alice/tours-skill';
import type { AliceRequest } from '@/lib/alice/types';
import type { MarketplaceTourRow } from '@/lib/search/tour-search';

/**
 * Разделитель разрядов у `toLocaleString('ru-RU')` — НЕРАЗРЫВНЫЙ пробел
 * (U+00A0), а не обычный. Записанный обычным, он делает тест зелёно-красным
 * по невидимому символу: строки на глаз одинаковы, сравнение падает.
 */
const NBSP = ' ';

describe('цена тура — три состояния', () => {
  it('число печатается человеку привычно и без «от»', () => {
    expect(priceSum(13000)).toBe(`13${NBSP}000 ₽`);
    expect(priceSum('28000.00')).toBe(`28${NBSP}000 ₽`);
    expect(priceWithUnitWords(13000, 'per_person')).not.toMatch(/(^|\s)от\s/);
  });

  it('цены нет — НЕТ, а не ноль', () => {
    expect(priceSum(null)).toBeNull();
    expect(priceSum(undefined)).toBeNull();
    expect(priceWithUnitWords(null, 'per_person')).toBeNull();
    expect(priceWithUnitWordsOrSay(null, 'per_person')).toBe('цена не указана');
    expect(priceWithUnitWordsOrSay(null, 'per_person', 'цена по запросу')).toBe('цена по запросу');
  });

  it('ноль и мусор — тоже не цена', () => {
    // Ноль невозможен по CHECK-ограничению колонки: пришедший ноль означает
    // поломку чтения, а не бесплатный тур. Печатать его нельзя ни в каком
    // случае.
    for (const v of [0, -5, '', 'не число']) {
      expect(priceSum(v as string | number), String(v)).toBeNull();
      expect(priceWithUnitWords(v as string | number, 'per_tour'), String(v)).toBeNull();
    }
  });
});

/**
 * ── Единица цены (29.09, сверка каналов MCP и каталога) ────────────────────
 *
 * Каталог сайта: «140 000 ₽/группа». MCP: «140 000 р/чел». Тот же тур, та же
 * цифра, единица выдумана: колонка `price_unit` существует с миграции 056 и в
 * запросы MCP не выбиралась. Агент называл человеку цену с человека — в 4-6
 * раз выше карточки.
 */
describe('цена называется в тех единицах, в каких назначена', () => {
  it('за группу — «за группу», а не «за человека»', () => {
    expect(priceWithUnitWords(140000, 'per_tour')).toBe(`140${NBSP}000 ₽ за группу`);
    expect(priceWithUnitWords(140000, 'per_tour')).not.toMatch(/чел/);
  });

  it('за человека в день — со словом «день»', () => {
    expect(priceWithUnitWords(28000, 'per_day_per_person')).toBe(`28${NBSP}000 ₽ за чел./день`);
  });

  it('за человека', () => {
    expect(priceWithUnitWords(13000, 'per_person')).toBe(`13${NBSP}000 ₽ за человека`);
  });

  it('единицы берутся из подписей каталога, а не из второго словаря', () => {
    for (const [unit, words] of Object.entries(PRICE_UNIT_LABELS)) {
      expect(priceWithUnitWords(1000, unit), unit).toBe(`1${NBSP}000 ₽ ${words}`);
      expect(priceUnitWords(unit), unit).toBe(words);
      expect(priceUnitKnown(unit), unit).toBe(true);
    }
  });

  it('единица не записана или незнакома — цена печатается, но за человека её НЕ объявляют', () => {
    // «за человека» здесь было бы тем же выдуманным числом, только словами.
    for (const unit of [null, undefined, '', 'per_zzz']) {
      const said = priceWithUnitWords(140000, unit as string | null | undefined);
      expect(said, String(unit)).toBe(`140${NBSP}000 ₽ — ${PRICE_UNIT_NOT_RECORDED}`);
      expect(said, String(unit)).not.toMatch(/за человека/);
      expect(priceUnitKnown(unit as string | null | undefined), String(unit)).toBe(false);
    }
  });
});

describe('единицы цены не вшиты ни в одну поверхность MCP', () => {
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tool = strip(readFileSync(join(process.cwd(), 'lib/kuzmich/tour-availability-tool.ts'), 'utf8'));
  const core = strip(readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8'));
  const label = strip(readFileSync(join(process.cwd(), 'lib/tours/price-label.ts'), 'utf8'));

  it('«р/чел» не зашито в get_tour_availability и каталог', () => {
    expect(tool, 'единица снова вписана строкой').not.toMatch(/р\/чел/);
    expect(core, 'единица снова вписана строкой').not.toMatch(/р\/чел/);
    // Сырое число цены в строку — запрет: формат один, lib/tours/price-label.
    expect(core).not.toMatch(/Number\([rt]\.base_price\)\.toLocaleString/);
  });

  it('все три запроса резолвера (номер, название, запасной по словам) выбирают price_unit', async () => {
    // Иначе единица снова «отбрасывается», а не «неизвестна». С 29.10 колонки
    // кандидата общие у трёх запросов (resolveTourChoice): судится вызов —
    // каждый отправленный запрос берёт ot.price_unit, и единица доходит до тура.
    const { pool } = await import('@/lib/db-pool');
    const { resolveTourChoice } = await import('@/lib/kuzmich/tour-availability-tool');
    const sent: string[] = [];
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      sent.push(sql);
      if (/ILIKE \$3/.test(sql) || /FROM partners p/.test(sql)) return { rows: [] };
      return { rows: [{ id: 5, title: 'Тур', operator_id: 'a', price_unit: 'per_group', stem_hits: [true, true] }] };
    }) as unknown as typeof pool.query);
    try {
      const byId = await resolveTourChoice('5');
      const byWords = await resolveTourChoice('Авачинский восхождение');
      expect(byId.kind === 'one' && byId.tour.price_unit).toBe('per_group');
      expect(byWords.kind === 'one' && byWords.tour.price_unit).toBe('per_group');
      const tourQueries = sent.filter((sql) => !/FROM partners p/.test(sql));
      expect(tourQueries).toHaveLength(3);
      expect(sent).toHaveLength(4);
      for (const sql of tourQueries) expect(sql).toMatch(/ot\.price_unit/);
    } finally {
      spy.mockRestore();
    }
  });

  it('каталог и детали выбирают price_unit', () => {
    expect(core).toMatch(/ot\.base_price, ot\.price_unit/);
    expect(core).toMatch(/SELECT id, title, base_price, price_unit, short_description/);
  });

  it('у общего формата нет умолчания для единицы и нет «от»', () => {
    // Умолчание «р/чел» и породило ложь: вызывающий не мог его не получить.
    expect(label).not.toMatch(/unit\s*=\s*'р\/чел'/);
    expect(label).not.toMatch(/`от \$\{/);
  });
});

/**
 * Переписи «все места, где цена читается сыро», здесь НЕТ намеренно: грубый
 * поиск по `Number(...base_price)` дал 23 файла, среди которых и правильные.
 * Разбор остальных мест идёт отдельно и по одному (§4.0).
 */

describe('голос Алисы не произносит «от нуля рублей»', () => {
  function tourRow(overrides: Partial<MarketplaceTourRow> = {}): MarketplaceTourRow {
    return {
      id: 1, title: 'Восхождение на Авачинский', description: 'Поход на вулкан.', short_description: null,
      base_price: 8500, price_old: null, price_unit: 'per_person', activity_type: 'trekking',
      location_type: 'volcano', location_name: 'Авачинский вулкан', tour_image: null, max_participants: 12,
      duration_hours: 10, duration_type: 'day', multi_day_count: null, difficulty: 'medium', included: null,
      season_start: null, season_end: null, operator_name: 'Тестовый оператор', operator_id: 'op-1',
      bookings_count: 0, has_availability: true, ...overrides,
    };
  }
  const ask = (command: string): AliceRequest => ({
    meta: { locale: 'ru-RU', timezone: 'Asia/Kamchatka', client_id: 'test' },
    request: { command, original_utterance: command, type: 'SimpleUtterance', nlu: { tokens: command.split(' '), entities: [] } },
    session: { message_id: 0, session_id: 's1', skill_id: 'skill1', user_id: 'u1', application: { application_id: 'a1' }, new: true },
    version: '1.0',
  });
  const fetchWith = (rows: MarketplaceTourRow[]): FetchTours => async () => ({ tours: rows, total: rows.length });

  it('навык называет цену общим форматом: сумма с единицей, без «от»', async () => {
    const res = await handleAliceTours(ask('какие есть туры'), fetchWith([tourRow()]));
    expect(res.response.text).toContain(`8${NBSP}500 ₽ за человека`);
    expect(res.response.text).not.toMatch(/от 8/);
  });

  it('отсутствие цены произносится словами, а не нулём', async () => {
    const res = await handleAliceTours(ask('какие есть туры'), fetchWith([tourRow({ base_price: null })]));
    expect(res.response.text).toContain('цена не указана');
    expect(res.response.text).not.toMatch(/(^|\s)0 ₽/);
  });

  it('навык не округляет сырое', () => {
    const skill = readFileSync(join(process.cwd(), 'lib/alice/tours-skill.ts'), 'utf8');
    expect(skill).not.toMatch(/Math\.round\(row\.base_price\)/);
  });
});
