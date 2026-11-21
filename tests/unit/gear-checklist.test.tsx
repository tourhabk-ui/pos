// @vitest-environment jsdom
/**
 * Чек-лист снаряжения из данных маршрута, без модели (21.11, слово владельца
 * «го»: «смотрю основные уходы с чеклиста»).
 *
 * Держит: список собирается только из записанного (паспорт, опасности,
 * МЧС, парк, сезон), чего нет — сказано словами; кнопка не молчит, когда
 * не хватает маршрута или даты; подсказки — только маршруты, популярные
 * видны без набора; модели в эндпоинте нет.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { buildGearChecklist, offSeasonPhrase, ESSENTIALS, type GearRouteFacts } from '@/lib/preparation/gear-checklist';
import { EquipmentClient, missingForSubmit, routeSuggestUrl } from '@/app/tools/equipment/_EquipmentClient';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ROUTE: GearRouteFacts = {
  id: 'r1', title: 'Вулкан Авачинский', equipment: ['трекинговые ботинки', 'палки'], hazards: ['rockfall'],
  mchsRequired: true, parkName: 'Налычево', season: 'summer', bestMonths: [],
};

describe('список — только записанное', () => {
  it('паспорт, опасности, МЧС и парк попадают в список; минимум — общий, с источником', () => {
    const c = buildGearChecklist(ROUTE, '2026-07-10')!;
    expect(c.passportEquipment).toEqual(['трекинговые ботинки', 'палки']);
    expect(c.hazards).toHaveLength(1);
    expect(c.steps.map((s) => s.href)).toEqual(['/register', '/routes/r1']);
    expect(c.essentials).toBe(ESSENTIALS);
    expect(c.monthLabel).toBe('июль');
    expect(c.offSeason).toBeNull();
    expect(c.prepareHref).toBe('/routes/r1/prepare');
  });

  it('паспорт снаряжения не называет — null, а не выдуманный список; МЧС не записано — шага нет', () => {
    const c = buildGearChecklist({ ...ROUTE, equipment: null, hazards: null, mchsRequired: false, parkName: null }, '2026-07-10')!;
    expect(c.passportEquipment).toBeNull();
    expect(c.hazards).toEqual([]);
    expect(c.steps).toEqual([]);
  });

  it('сезон: летний маршрут в декабре — сказано; «all» и пустота — не судим; лучшие месяцы главнее', () => {
    expect(offSeasonPhrase(12, 'summer', [])).toMatch(/летний/);
    expect(offSeasonPhrase(7, 'summer', [])).toBeNull();
    expect(offSeasonPhrase(12, 'all', [])).toBeNull();
    expect(offSeasonPhrase(12, null, [])).toBeNull();
    expect(offSeasonPhrase(12, 'summer', ['декабрь', 'январь'])).toBeNull();
    expect(offSeasonPhrase(7, null, ['Декабрь'])).toMatch(/Декабрь/);
  });

  it('дата не распознана — null', () => {
    expect(buildGearChecklist(ROUTE, '10.07.2026')).toBeNull();
  });
});

describe('эндпоинт без модели', () => {
  it('ни вызова модели, ни погоды числами без источника', () => {
    const src = readFileSync('app/api/tools/equipment/route.ts', 'utf8');
    expect(src).not.toMatch(/callAI|providers'/);
    expect(src).not.toMatch(/°C/);
    expect(src).toMatch(/buildGearChecklist/);
  });
});

describe('форма не молчит', () => {
  it('чего не хватает — словами', () => {
    expect(missingForSubmit(null, '')).toMatch(/маршрут.*дату/);
    expect(missingForSubmit(null, '2026-07-10')).toMatch(/маршрут/);
    expect(missingForSubmit({ id: 'r', title: 't' }, '')).toMatch(/дату/);
    expect(missingForSubmit({ id: 'r', title: 't' }, '2026-07-10')).toBeNull();
  });

  it('подсказки — только маршруты; пустой запрос — популярные', () => {
    expect(routeSuggestUrl('')).toBe('/api/routes?kind=route&sort=recommended&limit=6');
    expect(routeSuggestUrl('Авача')).toBe('/api/routes?kind=route&q=%D0%90%D0%B2%D0%B0%D1%87%D0%B0&limit=6');
  });

  it('нажатие на поле показывает популярные маршруты; под недоступной кнопкой — причина', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ id: 'r1', title: 'Вулкан Авачинский' }] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<EquipmentClient />);
    expect(screen.getByRole('button', { name: /Собрать чек-лист/ })).toBeDisabled();
    expect(screen.getByText('Выберите маршрут из списка и дату поездки')).toBeTruthy();
    fireEvent.focus(screen.getByLabelText('Маршрут'));
    await waitFor(() => expect(screen.getByText('Популярные маршруты')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/routes?kind=route&sort=recommended&limit=6');
    fireEvent.click(screen.getByRole('button', { name: 'Вулкан Авачинский' }));
    expect(screen.getByText('Укажите дату поездки')).toBeTruthy();
  });

  it('список не загрузился — сказано, а не пусто', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    render(<EquipmentClient />);
    fireEvent.focus(screen.getByLabelText('Маршрут'));
    await waitFor(() => expect(screen.getByText(/Список маршрутов не загрузился/)).toBeTruthy());
  });
});
