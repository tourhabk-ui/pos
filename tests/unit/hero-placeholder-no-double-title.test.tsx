/**
 * Имя места в герое без снимка не задваивается (04.10, снимок владельца:
 * «Этническое стойбище Кайныран» дважды, одно поверх «Исторического места»).
 * Заглушка с showLabel={false} рисовала имя всё равно — флаг гасил только род.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { RouteGradientPlaceholder } from '@/components/routes/RouteGradientPlaceholder';

afterEach(() => cleanup());

describe('RouteGradientPlaceholder', () => {
  it('showLabel={false} — имени внутри нет (его пишет экран)', () => {
    const { queryByText } = render(<RouteGradientPlaceholder title="Этническое стойбище Кайныран" locationType="historical" showLabel={false} />);
    expect(queryByText('Этническое стойбище Кайныран')).toBeNull();
  });
  it('по умолчанию имя есть — карточкам каталога оно нужно', () => {
    const { getByText } = render(<RouteGradientPlaceholder title="Этническое стойбище Кайныран" locationType="historical" />);
    expect(getByText('Этническое стойбище Кайныран')).toBeTruthy();
  });
});
