/**
 * Правка плана фразой без модели (фича 5, 23.11): разбор по правилам и
 * выбор дней по текущему плану. Неузнанная часть — отказ всей фразы.
 */
import { describe, it, expect } from 'vitest';
import { parsePlanPhrase, resolveIntent, PHRASE_EXAMPLES, type PhraseDay } from '@/lib/planner/phrase-edit';

const DAYS: PhraseDay[] = [
  { day: 1, type: 'arrival', title: 'Прилёт' },
  { day: 2, type: 'activity', activityType: 'fishing', title: 'Рыбалка на реке', realTour: { tourId: 't1' } },
  { day: 3, type: 'activity', activityType: 'volcano', title: 'Авачинский перевал' },
  { day: 4, type: 'travel', title: 'Дорога к месту тура', roadLeg: { tourId: 't5' } },
  { day: 5, type: 'activity', activityType: 'fishing', title: 'Рыбалка на базе', realTour: { tourId: 't5' } },
  { day: 6, type: 'travel', title: 'Дорога обратно', roadLeg: { tourId: 't5' } },
  { day: 7, type: 'activity', activityType: 'hot_spring', title: 'Термальный маршрут', realTour: { tourId: 't7' } },
  { day: 8, type: 'activity', activityType: 'hot_spring', title: 'Термальный маршрут', realTour: { tourId: 't7' } },
  { day: 9, type: 'rest', title: 'Свободный день' },
  { day: 10, type: 'activity', activityType: 'snowmobile', title: 'Снегоходы' },
  { day: 11, type: 'departure', title: 'Отъезд' },
];

function intents(p: string) {
  const r = parsePlanPhrase(p);
  if (!r.ok) throw new Error(r.error);
  return r.intents;
}

describe('разбор фразы', () => {
  it('все примеры подсказки разбираются', () => {
    for (const e of PHRASE_EXAMPLES) expect(parsePlanPhrase(e).ok, e).toBe(true);
  });

  it('три правила из задачи владельца', () => {
    expect(intents('без рыбалки')).toEqual([{ kind: 'remove_interest', interests: ['fishing'], words: 'рыбалки' }]);
    expect(intents('на день короче')).toEqual([{ kind: 'shorter', days: 1 }]);
    expect(intents('Замени день 3 на вулкан')).toEqual([{ kind: 'replace_day', day: 3, interest: 'volcano' }]);
  });

  it('другие формы', () => {
    expect(intents('на два дня короче')).toEqual([{ kind: 'shorter', days: 2 }]);
    expect(intents('убери день 4')).toEqual([{ kind: 'remove_day', day: 4 }]);
    expect(intents('поставь день 5 на место 2')).toEqual([{ kind: 'move_day', day: 5, to: 2 }]);
    expect(intents('день 6 — сплав')).toEqual([{ kind: 'replace_day', day: 6, interest: 'river' }]);
    expect(intents('добавь день рыбалки')).toEqual([{ kind: 'add_day', interest: 'fishing' }]);
    expect(intents('подешевле')).toEqual([{ kind: 'set_lodging', tier: 'economy' }]);
    expect(intents('на неделю позже')).toEqual([{ kind: 'shift_dates', days: 7 }]);
    expect(intents('на 3 дня раньше')).toEqual([{ kind: 'shift_dates', days: -3 }]);
    expect(intents('нас трое')).toEqual([{ kind: 'set_party', adults: 3 }]);
  });

  it('несколько правок через запятую и «и» перед глаголом', () => {
    expect(intents('убери рыбалку, добавь вулкан').map((i) => i.kind)).toEqual(['remove_interest', 'add_day']);
    expect(intents('без рыбалки и на неделю позже').map((i) => i.kind)).toEqual(['remove_interest', 'shift_dates']);
    expect(intents('без рыбалки и без вулканов').map((i) => i.kind)).toEqual(['remove_interest', 'remove_interest']);
    expect(intents('подешевле и нас трое').map((i) => i.kind)).toEqual(['set_lodging', 'set_party']);
  });

  it('без догадок: неузнанная часть, два занятия в одной замене, «отдых» — отказ всей фразы', () => {
    for (const p of ['сделай красиво', 'без рыбалки чтобы весело', 'без рыбалки, и чтобы весело', 'замени день 3 на вулкан и рыбалку', 'день 5 — отдых', 'добавь день']) {
      const r = parsePlanPhrase(p);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Не понял|Напишите/);
    }
    expect(parsePlanPhrase('').ok).toBe(false);
  });
});

describe('выбор дней по текущему плану', () => {
  it('«без рыбалки»: по одному дню на тур, связка — через тур; номера по убыванию', () => {
    const r = resolveIntent(intents('без рыбалки')[0], DAYS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual([{ action: 'remove_day', day: '5' }, { action: 'remove_day', day: '2' }]);
  });

  it('«без термальных» находит дни hot_spring, многодневный тур — одним днём', () => {
    const r = resolveIntent(intents('без термальных')[0], DAYS);
    expect(r.ok && r.args).toEqual([{ action: 'remove_day', day: '8' }]);
  });

  it('«на день короче»: сначала свободный день, многодневный тур не трогаем', () => {
    const r1 = resolveIntent({ kind: 'shorter', days: 1 }, DAYS);
    expect(r1.ok && r1.args).toEqual([{ action: 'remove_day', day: '9' }]);
    const r2 = resolveIntent({ kind: 'shorter', days: 2 }, DAYS);
    expect(r2.ok && r2.args).toEqual([{ action: 'remove_day', day: '10' }, { action: 'remove_day', day: '9' }]);
    if (r2.ok) expect(r2.said).toContain('день 10 «Снегоходы»');
  });

  it('нечего убрать — отказ словами, а не пустая правка', () => {
    const r = resolveIntent(intents('без медведей')[0], DAYS);
    expect(r.ok).toBe(false);
    const r2 = resolveIntent({ kind: 'shorter', days: 5 }, DAYS);
    expect(r2.ok).toBe(false);
  });
});
