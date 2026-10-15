/**
 * Обстановка у места на сегодня — одно правило на полосу «Сейчас», совет
 * Кузьмича на карточке и чат Кузьмича (15.10, §0 «честность»).
 *
 * До этого дня полоса писала «Сегодня можно идти» и «Запретов и
 * предупреждений нет» почти у всех мест: уровень считался по `is_open = TRUE`
 * (значение по умолчанию у всех мест) и по своей шкале, где действующее
 * предупреждение уровня 1 печаталось под «предупреждений нет», а критичное (2)
 * — «идти можно, но осторожно». Совет Кузьмича строкой ниже говорил своё.
 *
 * Судится вызовом и рендером: что человек видит в полосе и в совете.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PlaceRealtimeStatus from '@/components/places/PlaceRealtimeStatus';
import type { PlaceRealtime } from '@/components/places/types';
import { placeDayStatus, PLACE_STATUS_FRESH_MS, kamchatkaStamp } from '@/lib/safety/place-day-status';
import { buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';

afterEach(cleanup);

const NOW = Date.parse('2026-10-15T08:00:00.000Z');
const FRESH = new Date(NOW - 10 * 60 * 1000).toISOString();
const STALE = new Date(NOW - PLACE_STATUS_FRESH_MS - 60 * 1000).toISOString();

const rt = (over: Partial<PlaceRealtime> = {}): PlaceRealtime => ({
  isOpen: true, currentCrowds: null, currentWeather: null, activeAlerts: [], alertSeverity: 0,
  alertMessage: null, touristsToday: null, touristsHour: null,
  status: 'green', linkedVolcanoes: null, updatedAt: FRESH,
  ...over,
});

const strip = (r: PlaceRealtime, extra: { isVolcano?: boolean; volcanoColor?: string | null } = {}) => {
  render(<PlaceRealtimeStatus realtime={r} now={NOW} {...extra} />);
  return screen.getByRole('status').textContent ?? '';
};

describe('правило дня: placeDayStatus', () => {
  it('закрытие ставит человек — оно не протухает вместе с пересчётом', () => {
    expect(placeDayStatus({ isOpen: false, status: 'green', updatedAt: STALE }, NOW)).toEqual({ level: 'closed', stale: false });
    expect(placeDayStatus({ isOpen: false, status: null, updatedAt: null }, NOW).level).toBe('closed');
  });

  it('NULL в is_open — не «закрыто»: уровень решает пересчёт', () => {
    expect(placeDayStatus({ isOpen: null, status: 'yellow', updatedAt: FRESH }, NOW).level).toBe('yellow');
  });

  it('цвет пересчёта — только свежий', () => {
    expect(placeDayStatus({ isOpen: true, status: 'red', updatedAt: FRESH }, NOW).level).toBe('red');
    expect(placeDayStatus({ isOpen: true, status: 'green', updatedAt: STALE }, NOW)).toEqual({ level: 'unknown', stale: true });
  });

  it('нет пересчёта или непонятный статус — «не знаем», а не зелёный', () => {
    expect(placeDayStatus({ isOpen: true, status: 'green', updatedAt: null }, NOW)).toEqual({ level: 'unknown', stale: false });
    expect(placeDayStatus({ isOpen: true, status: null, updatedAt: FRESH }, NOW).level).toBe('unknown');
    expect(placeDayStatus({ isOpen: true, status: 'purple', updatedAt: FRESH }, NOW).level).toBe('unknown');
  });

  it('время — по Камчатке, независимо от пояса читающего', () => {
    // 08:00 UTC = 20:00 по Камчатке (UTC+12).
    expect(kamchatkaStamp('2026-10-15T08:00:00.000Z')).toMatch(/20:00/);
  });
});

describe('полоса «Сейчас»: что видит человек', () => {
  it('зелёный — «предупреждений нет» и прямо: это не проверка места; разрешения не даёт', () => {
    const text = strip(rt());
    expect(text).toContain('Предупреждений по месту нет');
    expect(text).toContain('не проверка самого места');
    expect(text).not.toMatch(/можно идти|Запретов и предупреждений нет/i);
  });

  it('действующее предупреждение под зелёным не прячется под «предупреждений нет»', () => {
    const text = strip(rt({ activeAlerts: ['Вилючинский перевал — проезд по пропускам'], alertSeverity: 1 }));
    expect(text).toContain('Серьёзных предупреждений нет');
    expect(text).toContain('Вилючинский перевал — проезд по пропускам');
    expect(text).not.toContain('Предупреждений по месту нет');
  });

  it('жёлтый пересчёта — предупреждение с заголовком из сводки', () => {
    const text = strip(rt({ status: 'yellow', activeAlerts: ['Паводок на реке Камчатка'], alertSeverity: 2 }));
    expect(text).toContain('Есть предупреждение');
    expect(text).toContain('Паводок на реке Камчатка');
    expect(text).not.toMatch(/можно/i);
  });

  it('красный пересчёта — «опасно», самое опасное предупреждение первым', () => {
    render(<PlaceRealtimeStatus realtime={rt({ status: 'red', activeAlerts: ['Сход селя', 'Ограничение проезда'], alertSeverity: 2 })} now={NOW} />);
    const lines = screen.getAllByText(/Сход селя|Ограничение проезда/).map((n) => n.textContent);
    expect(screen.getByRole('status').textContent).toContain('Сегодня там опасно');
    expect(lines).toEqual(['Сход селя', 'Ограничение проезда']);
  });

  it('красный без заголовков у вулкана — причина названа шкалой вулкана, не выдумана', () => {
    expect(strip(rt({ status: 'red', activeAlerts: [] }), { isVolcano: true, volcanoColor: 'orange' }))
      .toContain('Код вулкана KVERT — оранжевый');
    cleanup();
    expect(strip(rt({ status: 'yellow', activeAlerts: [], linkedVolcanoes: 'Мутновский' })))
      .toContain('Место у вулкана Мутновский');
    cleanup();
    expect(strip(rt({ status: 'red', activeAlerts: [] }))).toContain('Причину пересчёт не записал');
  });

  it('закрыто администратором — «закрыто», с его причиной или словами, что её нет', () => {
    expect(strip(rt({ isOpen: false, alertMessage: 'Тропа размыта' }))).toMatch(/Закрыто для посещения.*Тропа размыта/);
    cleanup();
    expect(strip(rt({ isOpen: false }))).toContain('Причина не записана');
  });

  it('NULL в is_open не читается как «закрыто»', () => {
    expect(strip(rt({ isOpen: null }))).not.toContain('Закрыто');
  });

  it('пересчёт встал — цвета нет, сказано почему; прежнее предупреждение не теряется', () => {
    const text = strip(rt({ updatedAt: STALE, activeAlerts: ['Сход селя'] }));
    expect(text).toContain('Обстановку сейчас не знаем');
    expect(text).toContain('давно не обновлялся');
    expect(text).toContain('В последнем пересчёте: Сход селя');
    expect(text).not.toContain('Предупреждений по месту нет');
  });

  it('свежесть видна словами того, что было, — пересчёт сводок, а не «проверили»', () => {
    const text = strip(rt({ updatedAt: '2026-10-15T07:50:00.000Z' }));
    expect(text).toContain('Сводки пересчитаны 15.10, 19:50 по Камчатке');
    expect(text).not.toContain('Проверили');
    cleanup();
    expect(strip(rt({ updatedAt: null }))).toContain('Когда пересчитывали — у нас не записано');
  });

  it('красный и закрытое липнут к верху при прокрутке, зелёный — нет', () => {
    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
      fireEvent.scroll(window);
    };
    render(<PlaceRealtimeStatus realtime={rt({ status: 'red', activeAlerts: ['Сход селя'] })} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).toContain('sticky');
    cleanup();
    render(<PlaceRealtimeStatus realtime={rt({ isOpen: false })} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).toContain('sticky');
    cleanup();
    render(<PlaceRealtimeStatus realtime={rt()} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).not.toContain('sticky');
  });
});

describe('совет Кузьмича на карточке говорит то же, что полоса', () => {
  const advise = (r: PlaceRealtime, volcano: { colorCode: string; observedAt: string | null } | null = null) =>
    buildPlaceAdvisory({ volcano, realtime: { ...placeDayStatus(r, NOW), activeAlerts: r.activeAlerts }, hazardTypes: [] }, NOW);

  it('значение по умолчанию TRUE не даёт «спокойно»: без пересчёта — «живых данных нет»', () => {
    const a = advise(rt({ status: null, updatedAt: null }));
    expect(a.tone).toBe('unknown');
    expect(a.headline).not.toMatch(/спокойно/i);
  });

  it('закрытое — «нет», а не «можно, но с оглядкой»', () => {
    const a = advise(rt({ isOpen: false }));
    expect(a.tone).toBe('danger');
    expect(a.headline).toBe('Сегодня сюда — нет');
    expect(a.lines.join(' ')).toContain('закрыто');
  });

  it('жёлтый пересчёта — осторожность без «можно»', () => {
    const a = advise(rt({ status: 'yellow', activeAlerts: ['Паводок'] }));
    expect(a.tone).toBe('caution');
    expect(a.headline).not.toMatch(/можно/i);
    expect(a.lines.join(' ')).toContain('Паводок');
  });

  it('зональный уровень 2 под жёлтым пересчётом — не «сегодня сюда — нет» (решение 03.10)', () => {
    // Раньше совет сам считал «уровень ≥ 2 → нельзя» и спорил с пересчётом.
    expect(advise(rt({ status: 'yellow', alertSeverity: 2, activeAlerts: ['Паводок в районе'] })).tone).toBe('caution');
  });

  it('зелёный — «по сводкам спокойно» с оговоркой; слабое предупреждение — «серьёзных нет»', () => {
    const calm = advise(rt());
    expect(calm.tone).toBe('ok');
    expect(calm.headline).toBe('По сводкам спокойно');
    expect(calm.lines.join(' ')).toContain('не проверка тропы');
    const weak = advise(rt({ activeAlerts: ['Ограничение проезда'], alertSeverity: 1 }));
    expect(weak.headline).toBe('Серьёзных предупреждений нет');
    expect(weak.lines.join(' ')).toContain('В сводках: Ограничение проезда');
  });

  it('спокойный вулкан не делает спокойным место, чьи сводки не пересчитаны', () => {
    const a = advise(rt({ updatedAt: STALE }), { colorCode: 'green', observedAt: FRESH });
    expect(a.tone).toBe('unknown');
    expect(a.headline).not.toMatch(/спокойно/i);
    expect(a.lines.join(' ')).toContain('Вулкан спокоен');
  });

  it('красный пересчёта — «нет», как у полосы', () => {
    expect(advise(rt({ status: 'red', activeAlerts: ['Сход селя'] })).tone).toBe('danger');
  });
});
