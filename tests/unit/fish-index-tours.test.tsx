/**
 * /fish (seomator 20.11): title, canonical и 29 meta уходили людям и
 * обходчикам вне htmlLimitedBots в <body> — справочник был целиком
 * синхронным, и Next 15.5 отдавал его оболочку раньше метаданных. Теперь
 * индекс, как и карточка вида, читает туры на рыбалку из базы и показывает их
 * блоком; не прочитались — прежняя кнопка в каталог.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const tours = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/fish/fishing-tours', () => ({ getFishingTours: async () => tours.rows }));

import FishIndexPage, { dynamic } from '@/app/fish/page';

afterEach(() => { cleanup(); tours.rows = []; });

describe('/fish читает туры на рыбалку', () => {
  it('рендер на запросе', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('туры из базы — блоком со ссылками на карточки', async () => {
    tours.rows = [{
      id: 7, slug: 'reka-bystraya', title: 'Рыбалка на реке Быстрой', base_price: 25000,
      operator_name: 'Оператор', operator_slug: null, operator_public: null, duration_hours: 10,
    }];
    render(await FishIndexPage());
    expect(screen.getByRole('heading', { level: 2, name: 'Туры на рыбалку' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Рыбалка на реке Быстрой' }).getAttribute('href')).toContain('reka-bystraya');
  });

  it('туров нет — кнопка в каталог', async () => {
    render(await FishIndexPage());
    expect(screen.getByRole('link', { name: 'Туры на рыбалку' }).getAttribute('href')).toBe('/routes?activity_type=fishing');
  });
});
