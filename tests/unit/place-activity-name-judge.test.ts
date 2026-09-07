/**
 * Судья «имя места называет активность, не факт местности» (§9 CLAUDE.md).
 *
 * Найдено 07.09: «Река Авача — рыбалка» — коммерческая активность в
 * таблице `places`, где обязаны лежать только географические факты.
 * У маршрутов (§13, title-standard.ts) активность в имени — норма
 * («Сплав по реке Быстрая»); у мест — обратное: подозрение на смешение
 * тура с точкой.
 */
import { describe, it, expect } from 'vitest';
import { judgePlaceActivityName } from '@/lib/places/activity-name-judge';

describe('настоящие имена мест проходят', () => {
  it.each([
    'Вулкан Горелый',
    'Дикие озерки',
    'Озеро Толмачёва',
    'Мишенная сопка',
    'Никольская сопка',
    'Бухта Буян',
    'Халактырский пляж',
  ])('%s', (name) => {
    expect(judgePlaceActivityName(name)).toEqual({ ok: true, matched: [] });
  });
});

describe('активность в имени — подозрение', () => {
  it('точный случай 07.09: «Река Авача — рыбалка»', () => {
    const v = judgePlaceActivityName('Река Авача — рыбалка');
    expect(v.ok).toBe(false);
    expect(v.matched).toEqual(['рыбалка']);
  });

  it('ловит слово в любом падеже/позиции', () => {
    expect(judgePlaceActivityName('Сплав по реке Быстрая').ok).toBe(false);
    expect(judgePlaceActivityName('Вертолётная экскурсия к вулкану').ok).toBe(false);
    expect(judgePlaceActivityName('Восхождение на Авачинский').ok).toBe(false);
    expect(judgePlaceActivityName('Дайвинг у мыса Лопатка').ok).toBe(false);
  });

  it('несколько слов — matched без дублей', () => {
    const v = judgePlaceActivityName('Поход и рыбалка на озере');
    expect(v.matched.sort()).toEqual(['поход', 'рыбалка']);
  });

  it('не ловит слово как часть другого слова (границы по words())', () => {
    // «структура» содержит «тур» подстрокой, но это не то же слово
    expect(judgePlaceActivityName('Структура вулкана').ok).toBe(true);
  });
});
