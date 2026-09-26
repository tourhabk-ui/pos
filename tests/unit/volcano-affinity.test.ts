/**
 * Сторож переписи «место относится к вулкану» (26.09): упоминание, а не
 * расстояние; падежи имени; соседство без упоминания — отдельно.
 */
import { describe, it, expect } from 'vitest';
import { volcanoMentioned, affinityFor, type AffinityPlace } from '@/lib/places/volcano-affinity';

const P = (id: string, name: string, lat: number | null, lng: number | null, desc: string | null = null, type = 'viewpoint'): AffinityPlace =>
  ({ id, name, type, lat, lng, visible: true, desc });

const MUTNOVSKY = P('v', 'Вулкан Мутновский', 52.4487, 158.1942, null, 'volcano');

describe('volcanoMentioned', () => {
  it('падежи и скобки: Мутновский, Мутновского, (Мутновский)', () => {
    expect(volcanoMentioned('Скитур на Мутновский вулкан', 'Вулкан Мутновский')).toBe(true);
    expect(volcanoMentioned('подъём к кратеру Мутновского', 'Вулкан Мутновский')).toBe(true);
    expect(volcanoMentioned('Водопад Опасный (Мутновский)', 'Вулкан Мутновский')).toBe(true);
  });

  it('многословное имя требует все слова', () => {
    expect(volcanoMentioned('Вид на Ключевскую сопку', 'Вулкан Ключевская сопка')).toBe(true);
    expect(volcanoMentioned('Посёлок Ключи', 'Вулкан Ключевская сопка')).toBe(false);
  });

  it('чужое имя — нет', () => {
    expect(volcanoMentioned('Смотровая на Горелый', 'Вулкан Мутновский')).toBe(false);
  });
});

describe('affinityFor', () => {
  const places = [
    P('a', 'Смотровая на Мутновский вулкан (точка А)', 52.69, 158.16),
    P('b', 'Дачные горячие источники', 52.53, 158.192, 'У подножия Мутновского вулкана'),
    P('c', 'Мутновская ГеоЭС', 52.5386, 158.2018),
    P('d', 'Фумарола', 52.4621, 158.1593),
  ];

  it('упомянувшие — с местом упоминания и расстоянием, по возрастанию', () => {
    const { mentioned } = affinityFor(MUTNOVSKY, places, 10);
    expect(mentioned.map((h) => [h.place.id, h.where])).toEqual([['b', 'desc'], ['c', 'name'], ['a', 'name']]);
    expect(mentioned[2].km).toBeGreaterThan(25);
  });

  it('соседство без упоминания — отдельно, не кандидат', () => {
    const { mentioned, nearOnly } = affinityFor(MUTNOVSKY, places, 10);
    expect(mentioned.map((h) => h.place.id)).not.toContain('d');
    expect(nearOnly.map((h) => h.place.id)).toEqual(['d']);
  });
});
