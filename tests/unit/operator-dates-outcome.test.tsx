/**
 * Что оператор ВИДИТ после записи дат в кабинете (ревью 22.10, этап B
 * «Открой даты словами»). Рендером, а не литералом исходника (правило 13.10).
 *
 * 1. «Свободные даты», массовое открытие (`BulkOpenResult`). Кабинет открывает
 *    и закрытые оператором даты (например, «Шторм»), и причина закрытия при
 *    этом снимается. До правки такая дата растворялась в «Открыто N», и
 *    открытая обратно после закрытия по погоде дата ничем не выделялась.
 *    Теперь — отдельная строка с датой и причиной.
 * 2. Карточка тура, «Добавить дату» (`TourDateAdd`). Роут пишет дату и
 *    скрытому туру и говорит об этом (`tour_hidden`, `message`), а карточка
 *    ответ не читала: оператор считал дату продающейся, хотя туристы её не
 *    видели. Теперь исход «записано, но не видно» и частичный отказ названы.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BulkOpenResult } from '@/app/hub/operator/calendar/_BulkOpenResult';
import TourDateAdd from '@/components/operator/Tours/TourDateAdd';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('итог массового открытия', () => {
  it('открытые снова — отдельной строкой, с датой и причиной закрытия', () => {
    render(<BulkOpenResult result={{
      opened: 9, updated: 0, skipped: 0, total: 9, refused: [],
      reopenedDates: [{ date: '2027-07-17', reason: 'Шторм' }, { date: '2027-07-18', reason: null }],
    }} />);
    expect(screen.getByText(/Открыто 9 дат/)).toBeTruthy();
    const line = screen.getByText(/Из них открыто снова 2 — были закрыты или сняты/).parentElement!;
    expect(line.textContent).toMatch(/17 июл.*«Шторм»/);
    expect(line.textContent).toMatch(/18 июл/);
    expect(line.textContent).toMatch(/Причина закрытия снята/);
  });

  it('ничего не открыто снова — строки нет; отказ ниже записанных — своей строкой', () => {
    render(<BulkOpenResult result={{
      opened: 0, updated: 0, skipped: 0, total: 1, refused: [{ date: '2027-07-03', taken: 9 }], reopenedDates: [],
    }} />);
    expect(screen.queryByText(/открыто снова/)).toBeNull();
    // При всех датах в отказе нет зелёного «Открыто 0».
    expect(screen.queryByText(/Открыто 0 дат/)).toBeNull();
    expect(screen.getByText(/Не открыто 1: уже записано больше мест/).parentElement!.textContent).toMatch(/записано 9/);
  });
});

describe('карточка тура: добавить дату', () => {
  function answer(body: Record<string, unknown>, status = 201) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  function addDate(onAdded = vi.fn(), onError = vi.fn()) {
    render(<TourDateAdd tourId="42" onAdded={onAdded} onError={onError} />);
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2027-07-05' } });
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }));
    return { onAdded, onError };
  }

  it('тур скрыт — дата записана, и сказано, что туристы её не видят', async () => {
    const fetchMock = answer({
      success: true, dates_added: 1, refused: [], tour_hidden: true,
      message: 'Открыто дат: 1. Тур скрыт — туристы увидят эти даты, когда вы его включите',
    });
    const { onAdded, onError } = addDate();
    expect((await screen.findByRole('status')).textContent).toMatch(/Тур скрыт — туристы увидят эти даты, когда вы его включите/);
    expect(onAdded).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ dates: [{ date: '2027-07-05', available_slots: 8 }] });
  });

  it('часть дат не открыта — записано больше мест: сказано словами', async () => {
    answer({ success: true, dates_added: 1, refused: [{ date: '2027-07-06', taken: 9 }], tour_hidden: false,
      message: 'Открыто дат: 1. Не открыто: 6 июля 2027 — уже записано 9' });
    addDate();
    expect((await screen.findByRole('status')).textContent).toMatch(/Не открыто: 6 июля 2027 — уже записано 9/);
  });

  it('обычный успех — без строки; отказ — в общую строку ошибки карточки', async () => {
    answer({ success: true, dates_added: 1, refused: [], tour_hidden: false, message: 'Открыто дат: 1' });
    const ok = addDate();
    await waitFor(() => expect(ok.onAdded).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    answer({ error: 'Даты не открыты: мест меньше, чем уже записано (5 июля 2027 — уже записано 9)' }, 409);
    const bad = addDate();
    await waitFor(() => expect(bad.onError).toHaveBeenCalledWith(expect.stringMatching(/уже записано 9/)));
    expect(bad.onAdded).not.toHaveBeenCalled();
  });
});
