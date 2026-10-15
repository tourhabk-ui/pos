/**
 * Карточка места, мелкие неправды (15.10, §0 «честность»):
 *
 *  1. два разных «до Петропавловска» на одной карточке: шапка и «Как
 *     добраться» считали от разных точек отсчёта и по-разному округляли;
 *  2. календарь сезона без дат заливал все двенадцать месяцев под заголовком
 *     «Когда лучше посещать» — читалось «круглый год», а дат не пишет никто;
 *  3. связь рода unknown («не установлено», §4.1) подписывалась «маршрут
 *     проходит через место»;
 *  4. значок погоды читал не то поле ответа и не появлялся никогда — а будь
 *     живым, выдал бы прогноз модели за погоду на месте.
 *
 * Судится вызовом и рендером.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { distanceToCity } from '@/lib/places/distance-to-city';
import { composeAccessText, type AccessFacts } from '@/lib/places/access-text';
import PlaceSeason from '@/components/places/PlaceSeason';
import PlaceRoutes from '@/components/places/PlaceRoutes';
import WeatherNowChip from '@/components/shared/WeatherNowChip';
import { parseWeatherNow } from '@/lib/weather/now-temperature';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base: AccessFacts = {
  name: 'Место', lat: 52.7, lng: 158.65, district: null, zone: null, accessInfo: null,
  routes: [], registrationRequired: false, eco: null, toursCount: 0,
};

describe('1. до Петропавловска — одно число на карточке', () => {
  it('шапка и «Как добраться» называют одно и то же расстояние', () => {
    for (const [lat, lng] of [[52.7, 158.65], [53.26, 158.83], [54.43, 160.14], [56.06, 160.64], [51.5, 156.9]]) {
      const hero = distanceToCity(lat, lng)!.label.match(/^([\d\s,]+) км/)![1].replace(/\s/g, '');
      const text = composeAccessText({ ...base, lat, lng })[0].match(/в ([\d\s,]+) км по прямой/)![1].replace(/\s/g, '');
      expect(text, `${lat}, ${lng}`).toBe(hero);
    }
  });
});

describe('2. календарь сезона', () => {
  it('без дат — сетки месяцев нет, текст о сезоне остаётся', () => {
    render(<PlaceSeason openFromDate={null} openToDate={null} bestSeason="Лучше всего — июль и август." seasonalNotes={null} />);
    expect(screen.queryByLabelText('Открыто для посещения по месяцам')).toBeNull();
    expect(screen.getByText('Лучше всего — июль и август.')).toBeTruthy();
  });

  it('с датами — сетка есть и подсвечены только месяцы окна', () => {
    const { container } = render(<PlaceSeason openFromDate="2026-06-01" openToDate="2026-09-30" bestSeason={null} seasonalNotes={null} />);
    expect(screen.getByLabelText('Открыто для посещения по месяцам')).toBeTruthy();
    expect(container.querySelectorAll('.bg-\\[var\\(--accent\\)\\]')).toHaveLength(4);
  });
});

describe('3. связь «не установлено» — не «через место»', () => {
  const route = (title: string, linkKind: string | null) => ({ id: title, slug: null, title, activityType: null, difficulty: null, distanceKm: null, durationHours: null, linkKind: linkKind as 'waypoint' | 'nearby' | 'unknown' | null });

  it('список: путь — «через это место», неразмеченное — отдельно и словами', () => {
    render(<PlaceRoutes placeId="p" routes={[route('Путь', 'waypoint'), route('Неразмеченный', 'unknown'), route('Без рода', null)]} />);
    const through = screen.getByText('Маршруты через это место').closest('section')!;
    expect(through.textContent).toContain('Путь');
    expect(through.textContent).not.toContain('Неразмеченный');
    const unmarked = screen.getByText('Ещё маршруты, связанные с местом').closest('section')!;
    expect(unmarked.textContent).toContain('Неразмеченный');
    expect(unmarked.textContent).toContain('Без рода');
    expect(unmarked.textContent).toContain('у нас не размечено');
  });

  it('«Как добраться»: неразмеченный маршрут не «проходит через место»', () => {
    const t = composeAccessText({ ...base, routes: [{ title: 'Неразмеченный', distanceKm: null, durationHours: null, difficulty: null, linkKind: 'unknown' }] }).join(' ');
    expect(t).not.toContain('Через место');
    expect(t).toContain('С местом связан маршрут каталога «Неразмеченный» — проходит ли он через само место, у нас не размечено.');
  });
});

describe('4. погода — прогноз, и названа прогнозом', () => {
  it('ответ роута { success, data } разбирается; прежнее чтение верхнего уровня — нет', () => {
    expect(parseWeatherNow({ success: true, data: { temperature: 7.4, lastUpdated: '2026-10-15T08:00:00.000Z' } }))
      .toEqual({ temp: 7, at: '2026-10-15T08:00:00.000Z' });
    expect(parseWeatherNow({ temperature: 7 })).toBeNull();
    expect(parseWeatherNow({ success: false, unavailable: true })).toBeNull();
  });

  it('значок показывает число со словом «прогноз» и полной подписью', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { temperature: 7.4 } }))));
    const { container } = render(<WeatherNowChip lat={53} lng={158} whose="места" />);
    await waitFor(() => expect(container.textContent).toContain('7°'));
    expect(container.textContent).toContain('прогноз');
    expect(container.firstElementChild?.getAttribute('title')).toBe('Температура сейчас по прогнозу погоды для координат места, а не замер на месте');
  });

  it('провайдеры не ответили — значка нет', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, unavailable: true }), { status: 503 })));
    const { container } = render(<WeatherNowChip lat={53} lng={158} whose="места" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});
