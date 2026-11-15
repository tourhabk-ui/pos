/**
 * Сторож: в плане поездки только цены с источником (слово владельца 14.11
 * «5 -1»: «убрать всё: в плане только цены туров, остальное — „цену называет
 * исполнитель“»).
 *
 * До 14.11 смета складывала с ценами туров вилки, зашитые в код: день
 * занятий без тура «по виду активности» (`pricePerPerson`), ночь «по зоне и
 * уровню» (`ZONE_ACCOMMODATION`), переезд между зонами (`costPerPerson`),
 * трансфер аэропорта 2 500–5 000 ₽, прилёт, отдых и вылет. Ни одного из этих
 * чисел не было в данных, а «Итого» с ними читалось как настоящая цена.
 *
 * Сторож держит поведение: смета, цена дня и ответ Кузьмича на плане без
 * туров не называют ни одной суммы, даже если в днях сохранённого плана ещё
 * лежат прежние вилки. Регулярка по исходнику — только запрет на возврат
 * таблиц средних цен.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { estimateGroup, calculatePriceBreakdown, NO_PRICES_YET, type EstimateDay } from '@/lib/planner/estimate';
import { dayPrice, dayPriceLine } from '@/lib/planner/day-price';
import { formatPlanPrice } from '@/lib/kuzmich/trip-plan-tool';

/** План, сохранённый до 14.11: в днях без тура лежат вилки из констант. */
const OLD_DAYS: EstimateDay[] = [
  { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', priceFrom: 0, priceTo: 3000 },
  { day: 2, type: 'activity', zone: 'avachinsky', title: 'Вулканы', priceFrom: 5000, priceTo: 15000 },
  { day: 3, type: 'travel', zone: 'avachinsky', title: 'Переезд: Авачинская зона → Западная зона', priceFrom: 5000, priceTo: 8000 },
  { day: 4, type: 'rest', zone: 'western', title: 'Термальные источники', priceFrom: 1500, priceTo: 5000 },
  { day: 5, type: 'buffer', zone: 'western', title: 'Резерв на погоду', priceFrom: 3000, priceTo: 6000 },
  { day: 6, type: 'departure', zone: 'avachinsky', title: 'Вылет', priceFrom: 0, priceTo: 2500 },
];
const PROFILE = { adults: 2, children: [6], budgetTier: 'premium' as const, tripOrigin: 'visitor' as const };
const AMOUNT = /\d[\d\s  ]*₽/;

describe('план без туров — ни одной суммы', () => {
  it('смета: итог ноль, каждая строка без суммы и говорит, кто назовёт цену', () => {
    const e = estimateGroup(OLD_DAYS, PROFILE);
    expect(e.total).toEqual([0, 0]);
    expect(e.lines.length).toBeGreaterThan(0);
    for (const l of e.lines) {
      expect(l.total, l.label).toBeNull();
      expect(l.source, l.label).toBe('open');
      expect(l.basis, l.label).not.toMatch(AMOUNT);
      expect(l.basis, l.label).toMatch(/цену называет (исполнитель|хозяин жилья|перевозчик)/);
    }
    expect(e.unpriced).toHaveLength(e.lines.length);
    // Прилёт, отдых и вылет без тура — не строки: покупать на них нечего.
    expect(e.lines.map((l) => l.label)).not.toContain('«Прилёт», день 1');
    expect(e.lines.map((l) => l.label)).not.toContain('«Термальные источники», день 4');
  });

  it('цены туров на человека: ноль туров, дни без тура названы числом', () => {
    expect(calculatePriceBreakdown(OLD_DAYS)).toEqual({
      tours: [0, 0], activityPricing: { tourPriced: 0, open: 2, excluded: 0, unpriced: 0 },
    });
  });

  it('карточка дня без тура цены не показывает, сколько бы ни лежало в дне', () => {
    for (const d of OLD_DAYS) {
      expect(dayPrice(d), d.title).toEqual({ kind: 'none' });
      expect(dayPriceLine(d), d.title).toBe('');
    }
  });

  it('ответ Кузьмича и MCP: «цен туров нет», ни одной суммы', () => {
    const lines = formatPlanPrice(calculatePriceBreakdown(OLD_DAYS), true, estimateGroup(OLD_DAYS, PROFILE));
    const text = lines.join('\n');
    expect(lines[0]).toBe('Цен туров за человека в плане нет.');
    expect(text).not.toMatch(AMOUNT);
    expect(text).not.toMatch(/Итого|Ориентир|уровень «/);
  });

  it('уровень жилья суммы не создаёт', () => {
    for (const budgetTier of ['economy', 'comfort', 'premium'] as const) {
      expect(estimateGroup(OLD_DAYS, { ...PROFILE, budgetTier }).total).toEqual([0, 0]);
    }
  });

  it('слова «цен нет» не утверждают, что туров нет: тур бывает без цены для группы', () => {
    expect(NO_PRICES_YET).not.toMatch(/тур[ыа]? не выбран/);
  });
});

describe('с туром — в сумме только цена тура', () => {
  it('тур за человека × группа; прочие строки без суммы', () => {
    const days: EstimateDay[] = [
      ...OLD_DAYS.slice(0, 1),
      { day: 2, type: 'activity', zone: 'avachinsky', title: 'Авачинский', priceFrom: 12000, priceTo: 12000, realPrice: 12000, realTour: { tourId: 't', priceUnit: 'per_person', lodgingIncluded: null } },
      ...OLD_DAYS.slice(2),
    ];
    const e = estimateGroup(days, PROFILE);
    expect(e.total).toEqual([36000, 36000]);
    expect(e.fromTours).toEqual([36000, 36000]);
    expect(e.lines.filter((l) => l.total).map((l) => l.source)).toEqual(['tour']);
  });
});

describe('запрет: таблиц средних цен в коде планера нет', () => {
  const ROOTS = ['lib/planner', 'app/planner', 'components/planner'];
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
  /** Строки кода без комментариев: история в комментариях имена называет. */
  const codeLines = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8').split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

  it('ни одного имени прежних таблиц и полей', () => {
    const banned = /\b(ZONE_ACCOMMODATION|AIRPORT_TRANSFER|INTEREST_PRICE|DEFAULT_PRICE|pricePerPerson|costPerPerson|pricePerNight|perPersonTotal|fromEstimates)\b/;
    const hits = ROOTS.flatMap(files).flatMap((p) => codeLines(p).filter((l) => banned.test(l)).map((l) => `${p}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  it('день без тура в движке и на экране рождается с ценой 0–0', () => {
    // Цена дня — только у тура: `realPrice ?? 0`. Любое другое число в
    // priceFrom/priceTo при создании дня — вилка без источника.
    const hits = ['lib/planner/engine.ts', 'app/planner/_PlannerClient.tsx', 'lib/planner/calendar-days.ts'].flatMap((p) =>
      codeLines(p).filter((l) => /\bprice(From|To):\s*(?=\S)(?!(0|realPrice \?\? 0|number)\b)/.test(l)).map((l) => `${p}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
});
