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
import { priceFrom, priceFromOrSay } from '@/lib/tours/price-label';

/**
 * Разделитель разрядов у `toLocaleString('ru-RU')` — НЕРАЗРЫВНЫЙ пробел
 * (U+00A0), а не обычный. Записанный обычным, он делает тест зелёно-красным
 * по невидимому символу: строки на глаз одинаковы, сравнение падает.
 */
const NBSP = '\u00A0';

describe('цена тура — три состояния', () => {
  it('число печатается человеку привычно', () => {
    expect(priceFrom(13000)).toBe(`от 13${NBSP}000 р/чел`);
    expect(priceFrom('28000.00')).toBe(`от 28${NBSP}000 р/чел`);
  });

  it('цены нет — НЕТ, а не ноль', () => {
    expect(priceFrom(null)).toBeNull();
    expect(priceFrom(undefined)).toBeNull();
    expect(priceFromOrSay(null)).toBe('цена не указана');
  });

  it('ноль и мусор — тоже не цена', () => {
    // Ноль невозможен по CHECK-ограничению колонки: пришедший ноль означает
    // поломку чтения, а не бесплатный тур. Печатать его нельзя ни в каком
    // случае.
    expect(priceFrom(0)).toBeNull();
    expect(priceFrom('')).toBeNull();
    expect(priceFrom('не число')).toBeNull();
  });

  it('единица измерения задаётся вызывающим, а не вшита', () => {
    expect(priceFrom(5000, '₽')).toBe(`от 5${NBSP}000 ₽`);
  });
});

describe('каталог и карточка тура печатают цену одним правилом', () => {
  const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');

  it('каталог зовёт общий формат, а не собирает свой', () => {
    expect(core).toContain('priceFromOrSay(r.base_price)');
    expect(core).not.toMatch(/Number\(r\.base_price\)\.toLocaleString/);
  });

  it('детали тура — тот же формат и честное слово при отсутствии', () => {
    expect(core).toContain('priceFrom(t.base_price)');
    expect(core).not.toMatch(/Number\(t\.base_price\)\.toLocaleString/);
    // Кузьмичу нельзя оставлять пустоту: модель заполнит её числом сама.
    expect(core).toContain('не называй числа');
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
