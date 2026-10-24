import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KraiStatusSlot } from '@/components/tours/KraiStatusSlot';

describe('чип обстановки не сдвигает герой', () => {
  it('пока статуса нет, место уже занято той же плашкой', () => {
    const { rerender } = render(<KraiStatusSlot hasAlert={null} />);
    const slot = screen.getByTestId('krai-status-slot');
    expect(slot).toHaveStyle({ minHeight: '44px' });
    expect(slot).toHaveTextContent('Обстановка в крае');
    expect(screen.queryByRole('link', { name: /Обстановка в крае/ })).toBeNull();

    rerender(<KraiStatusSlot hasAlert={false} />);
    const link = screen.getByRole('link', { name: /Обстановка в крае/ });
    expect(link).toHaveAttribute('href', '/safety');
    expect(slot).toHaveStyle({ minHeight: '44px' });
  });
});
