/**
 * Ступень связи названа, и вместе с ней — что из неё следует.
 *
 * На экране «На маршруте» был один флаг и одна подсказка: «Офлайн-режим:
 * карты и точки маршрута доступны». Она сообщала РЕЖИМ и умалчивала о двух
 * вещах, которые в поле важнее режима.
 *
 * Первое: доступность утверждалась безусловно, хотя карта лежит в телефоне,
 * только если её скачали. Без пакета офлайн — это пустой экран, а подсказка
 * обещала обратное.
 *
 * Второе: свежесть. Снимок трёхдневной давности и живые данные выглядели
 * одинаково. Вчерашнее предупреждение о циклоне сегодня не значит ничего, но
 * читается как сегодняшнее.
 *
 * Владелец сформулировал это как требование к продукту: не прятать ступень в
 * иконку Wi-Fi, а сказать строкой — online / кэш / offline и что из этого
 * следует.
 */
import { describe, it, expect } from 'vitest';
import {
  connectivityState, snapshotStamp, SNAPSHOT_STALE_MS,
} from '@/lib/on-route/connectivity';

const NOW = new Date('2026-08-10T14:00:00+12:00').getTime();
const HOUR = 3_600_000;

describe('связь есть', () => {
  const c = connectivityState({ online: true, packageAt: null, liveAt: null, now: NOW });

  it('ступень online и спокойный тон', () => {
    expect(c.step).toBe('online');
    expect(c.tone).toBe('calm');
  });

  it('следствий называть не нужно — всё живое', () => {
    expect(c.detail).toBe('');
  });
});

describe('связи нет и пакета нет — худший случай, и он назван', () => {
  const c = connectivityState({ online: false, packageAt: null, liveAt: null, now: NOW });

  it('ступень offline и тревожный тон', () => {
    expect(c.step).toBe('offline');
    expect(c.tone).toBe('alarm');
  });

  it('прямо сказано, что карты нет', () => {
    // Прежняя строка обещала обратное: «карты и точки маршрута доступны».
    expect(c.detail).toMatch(/нет/i);
    expect(c.title + c.detail).not.toMatch(/доступны/i);
  });

  it('и сразу сказано, что работает всегда', () => {
    // Иначе человек решит, что не работает ничего.
    expect(c.detail).toMatch(/112/);
  });
});

describe('связи нет, но пакет снят', () => {
  const c = connectivityState({
    online: false, packageAt: NOW - 2 * HOUR, liveAt: NOW - 3 * HOUR, now: NOW,
  });

  it('ступень кэша, а не полного офлайна', () => {
    expect(c.step).toBe('cache');
  });

  it('в заголовке стоит время снимка, а не слово «офлайн»', () => {
    expect(c.title).toMatch(/снимок от/i);
    expect(c.title).toMatch(/\d{2}:\d{2}/);
  });

  it('сказано, что живых предупреждений не будет', () => {
    expect(c.detail).toMatch(/живых предупреждений не будет/i);
  });

  it('свежий снимок — предупреждение, а не тревога', () => {
    expect(c.tone).toBe('warn');
  });
});

describe('старый снимок называется старым', () => {
  const old = connectivityState({
    online: false,
    packageAt: NOW - SNAPSHOT_STALE_MS - HOUR,
    liveAt: null,
    now: NOW,
  });

  it('тон поднимается до тревожного', () => {
    expect(old.tone).toBe('alarm');
  });

  it('сказано, что данные могли измениться', () => {
    expect(old.detail).toMatch(/могли измениться/i);
  });

  it('берётся самая свежая из двух отметок, а не первая попавшаяся', () => {
    const c = connectivityState({
      online: false,
      packageAt: NOW - SNAPSHOT_STALE_MS - HOUR, // старый пакет
      liveAt: NOW - HOUR,                        // но час назад была связь
      now: NOW,
    });
    expect(c.tone).toBe('warn');
  });
});

describe('время снимка читается человеком', () => {
  it('сегодня — с часом', () => {
    expect(snapshotStamp(NOW - HOUR, NOW)).toMatch(/^сегодня \d{2}:\d{2}$/);
  });

  it('вчера названо вчерашним', () => {
    expect(snapshotStamp(NOW - 20 * HOUR, NOW)).toMatch(/^вчера \d{2}:\d{2}$/);
  });

  it('позавчера и раньше — датой, а не «N часов назад»', () => {
    // «56 часов назад» человек в поле не переводит в дату.
    expect(snapshotStamp(NOW - 60 * HOUR, NOW)).toMatch(/^\d{2}\.\d{2} в \d{2}:\d{2}$/);
  });
});
