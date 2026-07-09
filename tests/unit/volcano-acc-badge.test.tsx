/**
 * tests/unit/volcano-acc-badge.test.tsx
 *
 * Бейдж авиационного цветового кода вулкана: рендерит подпись цвета,
 * высоту пепла и ссылку на KVERT.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import VolcanoAccBadge from '@/components/places/VolcanoAccBadge';

afterEach(() => cleanup());

describe('VolcanoAccBadge', () => {
  it('рендерит красный код с пеплом и источником', () => {
    render(<VolcanoAccBadge status={{
      colorCode: 'red', ashHeightM: 8000,
      summary: 'Лавовое фонтанирование продолжается.',
      sourceUrl: 'http://www.kscnet.ru/ivs/kvert/', observedAt: '2025-08-07T23:40:00Z',
    }} />);
    expect(screen.getByText(/Красный/)).toBeTruthy();
    expect(screen.getByText(/Пепел до 8.0 км/)).toBeTruthy();
    expect(screen.getByText('KVERT')).toBeTruthy();
    expect(screen.getByText(/Авиационный цветовой код/)).toBeTruthy();
  });

  it('неизвестный код деградирует до «не присвоен»', () => {
    render(<VolcanoAccBadge status={{
      colorCode: 'bogus', ashHeightM: null, summary: null, sourceUrl: null, observedAt: null,
    }} />);
    expect(screen.getByText(/Не присвоен/)).toBeTruthy();
  });
});
