/**
 * Карточка места не выдаёт незнание за хорошую новость (15.10, §0 «честность»).
 *
 *  - «Обновлено: <дата>» читалось как «сведения свежие», а дату двигает любая
 *    правка записи любым писателем: фото, заметка, координата;
 *  - пустой список опасностей объяснялся словами только у доказанного шаблона
 *    070, а у записи «источник не установлен» молчание читалось
 *    «опасностей нет».
 *
 * Подвал и строка опасностей — рендером; прежнее условие — запретом.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PlaceFooter from '@/components/places/PlaceFooter';
import PlaceHazardsUnknown from '@/components/places/PlaceHazardsUnknown';

afterEach(cleanup);

describe('подвал карточки', () => {
  it('дата — последней правки записи, а не «обновлено»', () => {
    const { container } = render(<PlaceFooter sourceUrl={null} sourceName={null} updatedAt="2026-10-15T08:00:00.000Z" />);
    expect(container.textContent).toContain('Последняя правка записи: 15 октября 2026');
    expect(container.textContent).not.toContain('Обновлено:');
  });
});

describe('пустой список опасностей', () => {
  const line = (hazards: string[], source: Parameters<typeof PlaceHazardsUnknown>[0]['source']) =>
    render(<PlaceHazardsUnknown hazards={hazards} source={source} />).container.textContent ?? '';

  it('объясняется для любого источника профиля, а не только для шаблона 070', () => {
    for (const source of ['unknown', 'manual', null] as const) {
      expect(line([], source), String(source)).toContain('Опасности этого места у нас не записаны — это не значит, что их нет.');
      cleanup();
    }
    expect(line([], 'type_template')).toContain('выведенный из типа места');
  });

  it('записанные опасности — строки нет', () => {
    expect(line(['bears'], 'manual')).toBe('');
  });

  it('карточка больше не гейтит строку шаблоном', () => {
    const src = readFileSync(join(process.cwd(), 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');
    expect(src).not.toMatch(/place\.safety\.source === 'type_template' && place\.safety\.hazardTypes\.length === 0 &&/);
  });
});
