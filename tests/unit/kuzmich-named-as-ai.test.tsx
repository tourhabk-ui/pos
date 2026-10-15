/**
 * Кузьмич назван тем, кто он есть — ИИ-помощником, и не обещает больше
 * данных платформы (15.10, §0 «честность»).
 *
 * На карточке места заметка шла под именем «Кузьмич» с аватаром «К» — так
 * подписывают местного гида, а пишет её модель по данным платформы. Пустое
 * состояние обещало «Кузьмич знает Камчатку как никто», приветствие виджета —
 * «знаю каждый маршрут Камчатки».
 *
 * Судится рендером блока; запрет на прежние обещания — регуляркой по исходнику.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PlaceKuzmich from '@/components/places/PlaceKuzmich';

afterEach(cleanup);

const text = (review: string | null) =>
  render(<PlaceKuzmich placeId="p" placeName="Озеро" kuzmichReview={review} advisory={null} />).container.textContent ?? '';

describe('Кузьмич на карточке места', () => {
  it('заметка подписана: написал ИИ-помощник по данным платформы', () => {
    const t = text('Летом здесь комары.');
    expect(t).toContain('Летом здесь комары.');
    expect(t).toContain('Заметку написал ИИ-помощник Ведара по данным платформы');
  });

  it('без заметки — кто он, без «знает как никто»', () => {
    const t = text(null);
    expect(t).toContain('ИИ-помощник');
    expect(t).not.toMatch(/как никто/);
  });
});

describe('прежние обещания не вернулись', () => {
  it('ни карточка, ни виджет не обещают знания сверх данных', () => {
    const src = ['components/places/PlaceKuzmich.tsx', 'components/kuzmich/KuzmichWidget.tsx']
      .map((f) => readFileSync(join(process.cwd(), f), 'utf-8').replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))
      .join('\n');
    expect(src).not.toMatch(/знает Камчатку как никто|знаю каждый маршрут/);
  });
});
