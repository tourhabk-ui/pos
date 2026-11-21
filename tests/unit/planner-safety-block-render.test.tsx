// @vitest-environment jsdom
/**
 * «Безопасность и разрешения» рендером (слово владельца 21.11): один блок,
 * свёрнут по умолчанию, каждая строка один раз с днями; критичное — числом
 * в заголовке.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SafetyBlock } from '@/components/planner/SafetyBlock';
import { safetyBlock } from '@/lib/planner/day-card-view';

afterEach(cleanup);

const days = [1, 2, 3].map((day) => ({
  day, type: 'activity', title: 'Камчатка: термальный маршрут',
  dayWarnings: ['Медведи: держитесь группой.', 'Связи нет — возьмите спутниковый коммуникатор.'],
}));

describe('SafetyBlock', () => {
  it('свёрнут, строки без повторов, с днями', () => {
    const items = safetyBlock(days, [{ type: 'permit', severity: 'critical', message: 'Кроноцкий заповедник — нужен пропуск.' }]);
    const { container } = render(<SafetyBlock items={items} />);
    const details = container.querySelector('details[data-safety-block]') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText('Безопасность и разрешения')).toBeTruthy();
    expect(screen.getByText(/важно: 1/)).toBeTruthy();
    expect(screen.getByText('3 пункта')).toBeTruthy();
    expect(screen.getAllByText(/^Медведи/)).toHaveLength(1);
    expect(screen.getByText('Медведи: держитесь группой. (дни 1–3)')).toBeTruthy();
  });

  it('пусто — блока нет', () => {
    const { container } = render(<SafetyBlock items={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
