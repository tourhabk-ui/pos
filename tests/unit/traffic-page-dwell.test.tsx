// @vitest-environment jsdom
/**
 * Просмотры с записанным временем — отдельный счёт на витрине трафика
 * (21.11, слово владельца «делай»; перепись уходов prod-check 205: у 358 из
 * 372 просмотров /planning видимое время не записано).
 *
 * Держит рендером: рядом с общим счётом — число просмотров со временем и
 * уход среди них; без таких просмотров — прочерк, а не «0%»; путь из
 * журнала — ссылкой только на страницу нашего сайта.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { PageBehaviorTable, DWELL_COLUMNS_NOTE, type PageBehaviorRow } from '@/app/hub/admin/traffic/_PageBehaviorTable';
import { dwellExitShare, pageDwellCounts } from '@/lib/analytics/page-dwell';

afterEach(() => cleanup());

const PLANNING: PageBehaviorRow = { path: '/planning', views: 372, medianMs: 4503, exits: 365, withDwell: 14, withDwellExits: 9 };
const EQUIPMENT: PageBehaviorRow = { path: '/tools/equipment', views: 75, medianMs: null, exits: 75, withDwell: 0, withDwellExits: 0 };

function rowOf(path: string): HTMLElement {
  const link = screen.getByText(path);
  const tr = link.closest('tr');
  if (!tr) throw new Error(`строка ${path} не найдена`);
  return tr;
}

describe('таблица поведения', () => {
  it('общий счёт и рядом — со временем и уход среди них', () => {
    render(<PageBehaviorTable rows={[PLANNING]} warnExitAt={70} />);
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual(['Страница', 'Просмотры', 'Уход', 'Со временем', 'Время', 'Уход среди них']);
    const cells = within(rowOf('/planning')).getAllByRole('cell').map(c => c.textContent);
    expect(cells).toEqual(['/planning', '372', '98%', '14', '5 с', '64%']);
  });

  it('нет просмотров со временем — прочерк, а не «0%»', () => {
    render(<PageBehaviorTable rows={[EQUIPMENT]} warnExitAt={70} />);
    const cells = within(rowOf('/tools/equipment')).getAllByRole('cell').map(c => c.textContent);
    expect(cells).toEqual(['/tools/equipment', '75', '100%', '0', '—', '—']);
  });

  it('путь сайта — ссылка на себя в новой вкладке, чужое — текст', () => {
    render(<PageBehaviorTable rows={[PLANNING, { ...EQUIPMENT, path: 'javascript:alert(1)' }]} warnExitAt={70} />);
    const link = screen.getByText('/planning');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/planning');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('javascript:alert(1)').tagName).toBe('SPAN');
  });

  it('подпись называет признак признаком, а не доказательством человека', () => {
    expect(DWELL_COLUMNS_NOTE).toMatch(/признак, а не доказательство человека/);
    expect(DWELL_COLUMNS_NOTE).toMatch(/медиана только по этим просмотрам/);
  });
});

describe('счёт со временем', () => {
  it('строки базы — числа; пустое — ноль', () => {
    expect(pageDwellCounts({ with_dwell: '14', with_dwell_exits: '9' })).toEqual({ withDwell: 14, withDwellExits: 9 });
    expect(pageDwellCounts({ with_dwell: null, with_dwell_exits: null })).toEqual({ withDwell: 0, withDwellExits: 0 });
  });

  it('доля ухода — null без просмотров, иначе проценты', () => {
    expect(dwellExitShare({ withDwell: 0, withDwellExits: 0 })).toBeNull();
    expect(dwellExitShare({ withDwell: 14, withDwellExits: 9 })).toBe(64);
    expect(dwellExitShare({ withDwell: 3, withDwellExits: 3 })).toBe(100);
  });
});
