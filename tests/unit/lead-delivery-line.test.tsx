/**
 * Строка «последняя заявка» в карточке оператора — рендером: человек видит
 * исход доставки словами, а «не прочитали» и «записей нет» различимы.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LeadDeliveryLine } from '@/components/admin/LeadDeliveryLine';

describe('LeadDeliveryLine', () => {
  it('доставлено: время по Камчатке и «доставлена лично в MAX»', () => {
    render(<LeadDeliveryLine delivery={{ at: '2026-10-15T02:46:12.000Z', state: 'delivered', channel: 'max', reason: null }} />);
    const p = screen.getByText(/Последняя заявка/);
    expect(p.textContent).toMatch(/15\.10/);
    expect(p.textContent).toMatch(/14:46/);
    expect(p.textContent).toMatch(/по Камчатке/);
    expect(p.textContent).toMatch(/доставлена лично в MAX/);
  });

  it('отказ: причина названа', () => {
    render(<LeadDeliveryLine delivery={{ at: '2026-10-15T02:46:12.000Z', state: 'failed', channel: 'max', reason: 'http_403 chat not found' }} />);
    expect(screen.getByText(/лично не доставлена \(max\): http_403 chat not found/)).toBeTruthy();
  });

  it('записей нет и прочитать не удалось — разные слова', () => {
    const { unmount } = render(<LeadDeliveryLine delivery={null} />);
    expect(screen.getByText(/записей о доставке нет/)).toBeTruthy();
    unmount();
    render(<LeadDeliveryLine delivery={undefined} />);
    expect(screen.getByText(/не удалось прочитать/)).toBeTruthy();
  });
});
