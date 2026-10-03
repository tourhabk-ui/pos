/**
 * Сторож цены тура: «не знаю» не превращается в ноль.
 *
 * 18.09, каталог с прода (MCP `get_tours`):
 *
 *   ID34 «Сплав по реке Быстрая (три дня)» — от 0 р/чел
 *
 * Нуля в базе нет и быть не может: у `operator_tours.base_price` стоит CHECK
 * `base_price > 0`, а колонка NULLABLE. То есть у тура цена НЕ ЗАПИСАНА, а
 * ноль родил формат — `Number(null)` это `0`.
 *
 * Тот же механизм уже стоил разбора денежного пути (§7, 11.09): `Number(null)`
 * давал нулевую комиссию платформы молча. Здесь он обещает бесплатный тур.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { priceFrom, priceFromOrSay, priceFromUnit, priceFromUnitOrSay } from '@/lib/tours/price-label';
import { PRICE_UNIT_SHORT } from '@/lib/tours/labels';

/**
 * Разделитель разрядов у `toLocaleString('ru-RU')` — НЕРАЗРЫВНЫЙ пробел
 * (U+00A0), а не обычный. Записанный обычным, он делает тест зелёно-красным
 * по невидимому символу: строки на глаз одинаковы, сравнение падает.
 */
const NBSP = '\u00A0';

describe('цена тура — три состояния', () => {
  it('число печатается человеку привычно', () => {
    expect(priceFrom(13000, 'р/чел')).toBe(`от 13${NBSP}000 р/чел`);
    expect(priceFrom('28000.00', 'р/чел')).toBe(`от 28${NBSP}000 р/чел`);
  });

  it('цены нет — НЕТ, а не ноль', () => {
    expect(priceFrom(null, '₽')).toBeNull();
    expect(priceFrom(undefined, '₽')).toBeNull();
    expect(priceFromOrSay(null, 'цена не указана', '₽')).toBe('цена не указана');
  });

  it('ноль и мусор — тоже не цена', () => {
    // Ноль невозможен по CHECK-ограничению колонки: пришедший ноль означает
    // поломку чтения, а не бесплатный тур. Печатать его нельзя ни в каком
    // случае.
    expect(priceFrom(0, '₽')).toBeNull();
    expect(priceFrom('', '₽')).toBeNull();
    expect(priceFrom('не число', '₽')).toBeNull();
  });

  it('единица измерения задаётся вызывающим, а не вшита', () => {
    expect(priceFrom(5000, '₽')).toBe(`от 5${NBSP}000 ₽`);
  });
});

describe('каталог и карточка тура печатают цену одним правилом', () => {
  const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');

  it('каталог зовёт общий формат с единицей тура, а не собирает свой', () => {
    expect(core).toContain('priceFromUnitOrSay(r.base_price, r.price_unit)');
    expect(core).not.toMatch(/Number\(r\.base_price\)\.toLocaleString/);
  });

  it('детали тура — тот же формат и честное слово при отсутствии', () => {
    expect(core).toContain('priceFromUnit(t.base_price, t.price_unit)');
    expect(core).not.toMatch(/Number\(t\.base_price\)\.toLocaleString/);
    // Кузьмичу нельзя оставлять пустоту: модель заполнит её числом сама.
    expect(core).toContain('не называй числа');
  });
});

/**
 * ── Единица цены (29.09, сверка каналов MCP и каталога) ────────────────────
 *
 * Каталог сайта: «140 000 ₽/группа». MCP: «140 000 р/чел». Тот же тур, та же
 * цифра, единица выдумана: колонка `price_unit` существует с миграции 056 и в
 * запросы MCP не выбиралась, а на её месте стояло зашитое «р/чел». Агент во
 * внешнем ассистенте называл человеку цену с человека — в 4-6 раз выше
 * карточки.
 */
describe('цена называется в тех единицах, в каких назначена', () => {
  it('за группу — «/группа», а не «/чел»', () => {
    expect(priceFromUnit(140000, 'per_tour')).toBe(`от 140${NBSP}000 ₽/группа`);
    expect(priceFromUnit(140000, 'per_tour')).not.toMatch(/чел/);
  });

  it('за человека в день — со словом «в день»', () => {
    expect(priceFromUnit(28000, 'per_day_per_person')).toBe(`от 28${NBSP}000 ₽/чел. в день`);
  });

  it('за человека — как раньше', () => {
    expect(priceFromUnit(13000, 'per_person')).toBe(`от 13${NBSP}000 ₽/чел.`);
  });

  it('единицы берутся из подписей каталога, а не из второго словаря', () => {
    // Каждая известная каталогу единица печатается его же словом.
    for (const [unit, short] of Object.entries(PRICE_UNIT_SHORT)) {
      expect(priceFromUnit(1000, unit), unit).toBe(`от 1${NBSP}000 ₽${short}`);
    }
  });

  it('единица не записана или незнакома — цена печатается, но за человека её НЕ объявляют', () => {
    // «за человека» здесь было бы тем же выдуманным числом, только словами.
    for (const unit of [null, undefined, '', 'per_zzz']) {
      const said = priceFromUnit(140000, unit as string | null | undefined);
      expect(said, String(unit)).toContain(`140${NBSP}000 ₽`);
      expect(said, String(unit)).toMatch(/не записано/);
      expect(said, String(unit)).not.toMatch(/₽\/чел/);
    }
  });

  it('цены нет — НЕТ при любой единице', () => {
    expect(priceFromUnit(null, 'per_tour')).toBeNull();
    expect(priceFromUnit(0, 'per_tour')).toBeNull();
    expect(priceFromUnitOrSay(null, 'per_tour')).toBe('цена не указана');
  });
});

describe('единицы цены не вшиты ни в одну поверхность MCP', () => {
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tool = strip(readFileSync(join(process.cwd(), 'lib/kuzmich/tour-availability-tool.ts'), 'utf8'));
  const core = strip(readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8'));
  const label = strip(readFileSync(join(process.cwd(), 'lib/tours/price-label.ts'), 'utf8'));

  it('«р/чел» не зашито в get_tour_availability', () => {
    expect(tool, 'единица снова вписана строкой').not.toMatch(/р\/чел/);
    expect(tool).toMatch(/priceFromUnit\(s\.priceOverride \?\? tour\.base_price, tour\.price_unit\)/);
  });

  it('оба запроса резолвера выбирают price_unit', () => {
    // Иначе единица снова «отбрасывается», а не «неизвестна».
    const selects = tool.match(/SELECT id, title, operator_id, base_price, price_unit, slug, multi_day_count, duration_hours FROM operator_tours/g) ?? [];
    expect(selects.length).toBe(2);
  });

  it('каталог и детали выбирают price_unit', () => {
    expect(core).toMatch(/ot\.base_price, ot\.price_unit/);
    expect(core).toMatch(/SELECT id, title, base_price, price_unit, short_description/);
  });

  it('у общего формата нет умолчания для единицы', () => {
    // Умолчание «р/чел» и породило ложь: вызывающий не мог его не получить.
    expect(label).not.toMatch(/unit\s*=\s*'р\/чел'/);
  });
});

/**
 * Переписи «все места, где цена читается сыро», здесь НЕТ намеренно.
 *
 * Первая редакция сторожа её завела — и грубый поиск по `Number(...base_price)`
 * дал 23 файла, среди которых `tour-channel-post.ts`, `app/_home/data.ts` и
 * сам `price-label.ts`, где null проверен правильно. Замораживать список,
 * членство в котором я не проверил построчно, значит выдать догадку за
 * перепись — ровно то, чего §4.0 не разрешает.
 *
 * Разбор остальных мест идёт отдельно и по одному. Два из них — денежный
 * путь (`lib/bookings/reserve.ts`, `booking.service.ts`: `Number(base_price) *
 * participants` даёт нулевую сумму брони) и фиды на чужие витрины; туда
 * правка идёт с планом (§5), а не попутно с показом в каталоге.
 */

describe('голос Алисы не произносит «от нуля рублей»', () => {
  const skill = readFileSync(join(process.cwd(), 'lib/alice/tours-skill.ts'), 'utf8');

  it('навык зовёт общий формат, а не округляет сырое', () => {
    // `Math.round(null)` это 0, и Алиса сказала бы «бесплатно». У голоса цена
    // ошибки выше, чем у экрана: сказанное вслух не перечитывают.
    expect(skill).toContain('priceFromOrSay(row.base_price');
    expect(skill).not.toMatch(/Math\.round\(row\.base_price\)/);
  });

  it('отсутствие цены произносится словами', () => {
    expect(priceFromOrSay(null, 'цена не указана', '₽')).toBe('цена не указана');
  });
});
