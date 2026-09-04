/**
 * «Как турист попадает на тур» — поле, которое блокировало ВСЕ восемь туров.
 *
 * Перепись готовности к чужой витрине держала `pickup` в списке недостающего
 * у каждого живого тура и считала его по пустому `meeting_point`. Владелец
 * 23.08 поправил: пустота там не забывчивость оператора — операторы забирают
 * туристов сами, фиксированной точки сбора у таких туров нет и быть не
 * должно. То есть колонка отвечала не на тот вопрос, и «пробел данных» был
 * пробелом нашей схемы.
 *
 * Покупателю нужно знать не «где точка сбора», а «меня заберут, я приду или
 * еду сам»: у этих трёх ответов разная цена поездки, разный багаж и разное
 * решение о покупке. Отсюда pickup_type с тремя значениями и NULL как честным
 * четвёртым (§4.0: у всякого поля есть исход «не знаю»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickupForCard, pickupWording, isPickupType, PICKUP_TYPES, type PickupType } from '@/lib/tours/pickup';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MIGRATION = read('migrations/932_operator_tours_pickup.sql');
const CENSUS = read('app/api/cron/channel-readiness/route.ts');
const CARD = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');

describe('словарь один на все поверхности', () => {
  it('три ответа, и каждый говорит туристу разное', () => {
    expect(PICKUP_TYPES).toEqual(['hotel_pickup', 'meeting_point', 'self_drive']);
    const summaries = PICKUP_TYPES.map((t) => pickupWording(t).summary);
    expect(new Set(summaries).size, 'два типа звучат одинаково — турист не различит').toBe(3);
    for (const t of PICKUP_TYPES) {
      expect(pickupWording(t).title.length).toBeGreaterThan(3);
    }
  });

  it('чужое значение типом не считается', () => {
    expect(isPickupType('hotel_pickup')).toBe(true);
    expect(isPickupType('pickup')).toBe(false);
    expect(isPickupType(null)).toBe(false);
    expect(isPickupType('')).toBe(false);
  });

  it('подробности обязательны там, где без них ответ бесполезен', () => {
    expect(pickupWording('hotel_pickup').detailsNeeded).not.toBe('');
    expect(pickupWording('meeting_point').detailsNeeded).not.toBe('');
    // «Добирается сам» — исключение: куда ехать, отвечают координаты тура.
    expect(pickupWording('self_drive').detailsNeeded).toBe('');
  });
});

describe('карточка молчит, когда не записано', () => {
  it('нет типа — нет блока: «уточните у оператора» вместо ответа не выдумываем', () => {
    expect(pickupForCard(null, 'Заберём от отеля')).toBeNull();
    expect(pickupForCard('', null)).toBeNull();
    expect(pickupForCard('что-то своё', 'текст')).toBeNull();
  });

  it('тип есть — блок называет суть, даже если подробностей нет', () => {
    const p = pickupForCard('hotel_pickup', null);
    expect(p).not.toBeNull();
    expect(p!.title).toBe('Вас заберут');
    expect(p!.lines).toEqual([]);
  });

  it('подробности разбиваются по строкам, пустые строки выбрасываются', () => {
    const p = pickupForCard('meeting_point', 'Сбор у стелы, 07:30\n\n  Парковка бесплатная  ');
    expect(p!.lines).toEqual(['Сбор у стелы, 07:30', 'Парковка бесплатная']);
  });

  it('старый meeting_point подхватывается, если подробности не перенесены', () => {
    const p = pickupForCard('meeting_point', null, '147-й км трассы А4');
    expect(p!.lines).toEqual(['147-й км трассы А4']);
    // Но только для встречи: «заберут» из старой точки сбора не выводится.
    expect(pickupForCard('hotel_pickup', null, '147-й км трассы А4')!.lines).toEqual([]);
  });
});

describe('схема: три значения и честный NULL', () => {
  it('колонки заведены, значения ограничены схемой, а не только кодом', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS pickup_type VARCHAR\(16\)/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS pickup_details TEXT/);
    expect(MIGRATION).toMatch(/CHECK \(pickup_type IS NULL OR pickup_type IN \('hotel_pickup', 'meeting_point', 'self_drive'\)\)/);
  });

  it('перенос старых данных идемпотентен и не затирает ответ оператора', () => {
    expect(MIGRATION).toMatch(/WHERE pickup_type IS NULL/);
    expect(MIGRATION).toMatch(/SET pickup_type\s+= 'meeting_point'/);
  });

  it('комментарий колонки называет NULL «не записано», а не «нет трансфера»', () => {
    expect(MIGRATION).toMatch(/NULL — не записано, а НЕ «нет трансфера»/);
  });
});

describe('перепись готовности судит по ответу, а не по тексту точки сбора', () => {
  it('нет типа — пробел; тип есть, а подробностей нет — ДРУГОЙ пробел', () => {
    expect(CENSUS).toMatch(/if \(r\.pickup_type === null\) \{\s*\n\s*missing\.push\('pickup'\);/);
    expect(CENSUS).toMatch(/missing\.push\('pickup_details'\)/);
  });

  it('«добирается сам» не требует подробностей', () => {
    expect(CENSUS).toMatch(/r\.pickup_type !== 'self_drive' && r\.pickup_details_chars === 0/);
  });

  it('старая проверка по meeting_point из приговора убрана', () => {
    const code = CENSUS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const gate = code.slice(code.indexOf('export function missingFields'), code.indexOf('\n}', code.indexOf('export function missingFields')));
    expect(gate, 'перепись снова требует точку сбора там, где оператор забирает сам')
      .not.toMatch(/has_meeting_point/);
  });
});

describe('карточка тура', () => {
  it('рисует ответ через общий словарь, а не собирает слова заново', () => {
    expect(CARD).toMatch(/import \{ pickupForCard \} from '@\/lib\/tours\/pickup'/);
    expect(CARD).toMatch(/pickupForCard\(tour\.pickup_type, tour\.pickup_details, tour\.meeting_point\)/);
  });

  it('старый блок точки сбора показывается только при пустом новом поле', () => {
    expect(CARD).toMatch(/\{!tour\.pickup_type && tour\.meeting_point && \(/);
  });
});
