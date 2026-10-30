// @vitest-environment jsdom
/**
 * Форма заявки хозяину (объект без номеров) знает слово хозяина «занято»
 * (30.10): показывает закрытые даты до выбора, на закрытые даты заявку не
 * отправляет и говорит почему; занятость не загрузилась — сказано, а не
 * «всё свободно» (§4.0). Рендером, правило 13.10.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { StayRequestForm } from '@/components/stay/StayRequestForm';

vi.mock('@/components/legal/PdConsentCheckbox', () => ({
  PdConsentCheckbox: ({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) => (
    <input id={id} type="checkbox" aria-label="согласие" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));
vi.mock('@/components/requests/RequestChatLinks', () => ({ RequestChatLinks: () => null }));

const ACC = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const fetchMock = vi.fn();

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka' }).format(new Date());
}
function plus(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const ru = (d: string) => d.split('-').reverse().join('.');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StayRequestForm — занятые даты хозяина', () => {
  it('закрытые даты видны до выбора; заявка на них не уходит, и сказано почему', async () => {
    const t = today();
    const busy = [plus(t, 3), plus(t, 4), plus(t, 5)];
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true, data: { blockedDates: busy } }) });
    render(<StayRequestForm accommodationId={ACC} phoneLabel="+7 900" ownerOnMax />);

    await waitFor(() => expect(screen.getByTestId('stay-busy-dates')).toBeTruthy());
    expect(screen.getByTestId('stay-busy-dates').textContent).toContain(`Хозяин отметил занятыми: с ${ru(busy[0]!)} по ${ru(busy[2]!)}.`);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`/api/accommodations/${ACC}/blocked-dates?startDate=${t}&endDate=${plus(t, 180)}`);

    // Заезд на закрытую ночь: кнопка неактивна, причина названа, запрос не ушёл.
    const [checkIn, checkOut] = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/) as HTMLInputElement[];
    fireEvent.change(checkIn!, { target: { value: plus(t, 4) } });
    fireEvent.change(checkOut!, { target: { value: plus(t, 6) } });
    fireEvent.click(screen.getByLabelText('согласие'));
    const button = screen.getByRole('button', { name: /Отправить заявку/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(`Хозяин отметил эти даты занятыми: с ${ru(plus(t, 4))} по ${ru(plus(t, 5))}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Заезд сразу после занятого — можно.
    fireEvent.change(checkIn!, { target: { value: plus(t, 6) } });
    fireEvent.change(checkOut!, { target: { value: plus(t, 8) } });
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('занятость не загрузилась — сказано, форма не говорит «свободно» и не блокируется', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<StayRequestForm accommodationId={ACC} phoneLabel={null} ownerOnMax={false} />);
    await waitFor(() => expect(screen.getByText(/Занятые даты не загрузились/)).toBeTruthy());
    expect(screen.queryByTestId('stay-busy-dates')).toBeNull();
    fireEvent.click(screen.getByLabelText('согласие'));
    expect((screen.getByRole('button', { name: /Отправить заявку/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('сервер ответил 409 «занято» — даты из ответа показаны и кнопка гаснет', async () => {
    const t = today();
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { blockedDates: [] } }) })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({ success: false, error: 'Хозяин отметил эти даты занятыми: 01.01.2099.', data: { busyDates: [plus(t, 1)] } }),
      });
    render(<StayRequestForm accommodationId={ACC} phoneLabel={null} ownerOnMax />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Анна' } });
    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+79990001122' } });
    fireEvent.click(screen.getByLabelText('согласие'));
    const [checkIn, checkOut] = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/) as HTMLInputElement[];
    fireEvent.change(checkIn!, { target: { value: plus(t, 1) } });
    fireEvent.change(checkOut!, { target: { value: plus(t, 2) } });
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Хозяин отметил эти даты занятыми');
    expect(screen.getByTestId('stay-busy-dates').textContent).toContain(ru(plus(t, 1)));
    expect((screen.getByRole('button', { name: /Отправить заявку/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
