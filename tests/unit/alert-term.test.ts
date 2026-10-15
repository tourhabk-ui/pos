/**
 * Срок записи ленты — одно правило для сайта и MCP (#2495, владелец 15.10 «го»).
 *
 * Сайт писал «действует до 1 янв.» под «Вилючинский перевал: проезд по
 * пропускам с 15 июля» — ручной записью, у которой окончание не объявлено, а
 * `expires_at` поставлен заглушкой (миграция 718). Десктопная главная писала
 * «до 1 января» там же и «до 15 октября» у дорожного закрытия, чей срок —
 * неделя жизни записи ингеста. MCP после #2503 говорит «в ленте до»; здесь
 * то же правило на двух поверхностях сайта.
 *
 * Сторож — вызовом (правило 13.10): общее правило, подпись ленты
 * (`alertStamp`) и подпись «Что меняет план» (`planChangeTerm`).
 */
import { describe, it, expect } from 'vitest';
import { alertTerm, isTechnicalExpiry } from '@/lib/safety/alert-dates';
import { alertStamp } from '@/components/safety/LiveStatus';
import { planChangeTerm } from '@/lib/home/desk-brief';

/** 15.10.2026 13:30 по Камчатке. */
const NOW = Date.parse('2026-10-15T01:30:00Z');

// Вилючинский перевал (718): внесено 7 июля 13:23 МСК, заглушка 2027-01-01.
const VIL = { at: '2026-07-07T10:23:09.000Z', until: '2027-01-01T00:00:00.000Z' };
// Закрытие Октябрьской косы по ленте МЧС: неделя жизни записи (TTL ингеста).
const TTL = { at: '2026-10-08T07:40:00.000Z', until: '2026-10-15T07:40:00.000Z' };
// «Пока до 10 утра» — срок назван в посте (road-channel).
const STATED = { at: '2026-10-14T20:05:00.000Z', until: '2026-10-14T22:00:00.000Z' };

describe('правило срока', () => {
  it('ручная запись — окно ленты, сколько бы ни было до срока', () => {
    expect(alertTerm({ ...VIL, manual: true })).toBe('feed_window');
    expect(alertTerm({ ...STATED, manual: true })).toBe('feed_window');
  });

  it('TTL ингеста — срок жизни записи, названный в источнике срок — срок', () => {
    expect(isTechnicalExpiry(TTL.at, TTL.until)).toBe(true);
    expect(alertTerm({ ...TTL, manual: false })).toBe('technical');
    expect(alertTerm({ ...STATED, manual: false })).toBe('source');
  });

  it('срока нет — так и сказано', () => {
    expect(alertTerm({ at: VIL.at, until: null, manual: true })).toBe('none');
    expect(alertTerm({ at: TTL.at, until: null })).toBe('none');
  });
});

describe('подпись строки ленты (главная, /safety)', () => {
  it('ручная запись: когда внесли и до какого числа в ленте — без «действует до»', () => {
    const stamp = alertStamp({ type: 'road_closure', ...VIL, manual: true });
    expect(stamp).toMatch(/^внесено вручную 7 июл\.( 2026 г\.)? · в ленте до 1 янв\.( 2027 г\.)?$/);
    expect(stamp).not.toMatch(/действует/);
  });

  it('ручная запись без срока — только дата внесения', () => {
    expect(alertStamp({ type: 'road_closure', at: VIL.at, until: null, manual: true }))
      .toMatch(/^внесено вручную 7 июл\.( 2026 г\.)?$/);
  });

  it('у записей лент — прежнее правило: TTL — «сообщение от», названный срок — «действует до»', () => {
    expect(alertStamp({ type: 'road_closure', ...TTL, manual: false })).toMatch(/^сообщение от 8 окт\./);
    expect(alertStamp({ type: 'road_closure', ...STATED })).toMatch(/^действует до 15 окт\.?( 2026 г\.)?, 10:00$/);
  });
});

describe('подпись «Что меняет план» (десктоп)', () => {
  it('ручная запись — «в ленте до», с годом, если он не текущий', () => {
    expect(planChangeTerm(VIL.at, VIL.until, true, NOW)).toBe('в ленте до 1 января 2027 г.');
  });

  it('TTL ингеста — дата сообщения, а не «до»', () => {
    expect(planChangeTerm(TTL.at, TTL.until, false, NOW)).toBe('сообщение от 8 октября');
  });

  it('названный срок — «до»; дальше полугода и без срока — подписи нет', () => {
    expect(planChangeTerm('2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', false, NOW)).toBe('до 20 октября');
    expect(planChangeTerm('2026-10-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z', false, NOW)).toBeNull();
    expect(planChangeTerm(TTL.at, null, false, NOW)).toBeNull();
  });
});
