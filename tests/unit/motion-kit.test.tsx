// @vitest-environment jsdom
/**
 * Пять анимаций из каталога Motion (12.11, выбор владельца «Все пять»):
 * кнопка заявки с галочкой, шаги заявки, «Кузьмич думает», билет заявки,
 * колода мест. Сторож судит то, что видит человек (§«Сторож судит поведение»):
 * подписи, состояния, ссылки и слова билета — рендером и вызовом.
 *
 * Главное, что держится здесь, — честность анимации:
 * - галочка «отправлено» — только по фазе `done`, которую форма ставит после
 *   ответа сервера;
 * - шаги не выдумываются: у нераспознанного состояния их нет;
 * - билет говорит «заявка, а не бронь», без штрихкода и номера места;
 * - «думает» не называет шагов модели, только время ожидания;
 * - пауза галочки пропускается, когда движение не разрешено явно.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { ThinkingText } from '@/components/ui/ThinkingText';
import { RequestSteps } from '@/components/requests/RequestSteps';
import { RequestTicket, ticketStub, type TicketView } from '@/components/requests/RequestTicket';
import { PlaceSwipeDeck, swipeDirection, placeHref } from '@/components/places/PlaceSwipeDeck';
import { requestSteps, stepsProgress } from '@/lib/requests/request-steps';
import { doneBeatMs, DONE_BEAT_MS } from '@/lib/ui/motion-pref';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('кнопка заявки: отправить → отправляем → галочка', () => {
  it('подпись читается по фазе, остальные скрыты от читалки', () => {
    const { rerender } = render(<SubmitButton phase="idle" idleLabel="Отправить заявку" />);
    expect(screen.getByRole('button', { name: 'Отправить заявку' })).toBeEnabled();

    rerender(<SubmitButton phase="sending" idleLabel="Отправить заявку" />);
    const sending = screen.getByRole('button', { name: /Отправляем…/ });
    expect(sending).toBeDisabled();
    expect(sending).toHaveAttribute('aria-busy', 'true');

    rerender(<SubmitButton phase="done" idleLabel="Отправить заявку" />);
    const done = screen.getByRole('button', { name: /Заявка отправлена/ });
    expect(done).toBeDisabled();
    expect(done).toHaveAttribute('data-phase', 'done');
  });

  it('у каждой подписи есть «уменьшить движение»', () => {
    const { container } = render(<SubmitButton phase="idle" idleLabel="Отправить" />);
    const layers = container.querySelectorAll('button > span');
    expect(layers).toHaveLength(3);
    for (const l of layers) expect(l.className).toContain('motion-reduce:transition-none');
  });
});

describe('пауза галочки', () => {
  const stubMedia = (reduce: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));

  it('движение разрешено — короткая пауза', () => {
    stubMedia(false);
    expect(doneBeatMs()).toBe(DONE_BEAT_MS);
    expect(DONE_BEAT_MS).toBeLessThan(1000);
  });

  it('«уменьшить движение» — без паузы', () => {
    stubMedia(true);
    expect(doneBeatMs()).toBe(0);
  });
});

describe('Кузьмич думает', () => {
  it('одна фраза для читалки, без шагов модели; долгое ожидание называется', () => {
    vi.useFakeTimers();
    render(<ThinkingText slowAfterMs={8000} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Кузьмич думает');
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Кузьмич думает, отвечает дольше обычного');
    expect(screen.getByRole('status').textContent).not.toMatch(/ищу|смотрю|проверяю/i);
  });
});

describe('шаги заявки', () => {
  it('нераспознанное и пробное состояние шагов не получают', () => {
    expect(requestSteps('unknown', 'operator')).toBeNull();
    expect(requestSteps('test', 'operator')).toBeNull();
  });

  it('ждём ответа: второй шаг текущий, третий впереди', () => {
    const s = requestSteps('awaiting_operator', 'operator')!;
    expect(s.map((x) => x.mark)).toEqual(['done', 'current', 'todo']);
    expect(s[1].label).toBe('Передана оператору');
    expect(s[2].label).toBe('Ответ оператора');
    expect(stepsProgress(s)).toBe(0.5);
  });

  it('адресат — по роду заявки, исход — словом и тоном', () => {
    expect(requestSteps('delivered', 'carrier')![1].label).toBe('Передана перевозчику');
    const ok = requestSteps('confirmed', 'operator')!;
    expect(ok.every((x) => x.mark === 'done')).toBe(true);
    expect(ok[2]).toMatchObject({ label: 'Подтверждена', tone: 'ok' });
    expect(requestSteps('declined', 'stay')![2]).toMatchObject({ label: 'Отказ', tone: 'stop' });
    expect(requestSteps('other_date', 'operator')![2]).toMatchObject({ mark: 'current', tone: 'warn' });
  });

  it('рендер: текущий шаг помечен для читалки', () => {
    render(<RequestSteps steps={requestSteps('awaiting_operator', 'stay')!} />);
    const list = screen.getByRole('list', { name: 'Путь заявки' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[1].textContent).toContain('Передана владельцу жилья');
    expect(items[1].textContent).toContain('сейчас');
  });
});

describe('билет заявки — не бронь', () => {
  const base: TicketView = {
    state: 'awaiting_operator', kind: 'lead', consent_purpose: 'operator',
    tour: 'Восхождение на Авачинский', accommodation: null,
    date: '2026-12-05', check_out: null, participants: 2,
  };

  it('сверху «Заявка», корешок говорит, кто подтверждает', () => {
    render(<RequestTicket view={base} />);
    const t = screen.getByRole('region', { name: 'Заявка' });
    expect(t.textContent).toContain('Восхождение на Авачинский');
    expect(t.textContent).toContain('Участников');
    expect(t.textContent).toMatch(/Это заявка, а не бронь: подтверждает оператор/);
    expect(t.textContent).not.toMatch(/Бронь оформлена|Билет|Место №|QR/i);
    expect(t.querySelector('svg, img, canvas')).toBeNull();
  });

  it('подтверждение — словами адресата, оплата не через платформу', () => {
    expect(ticketStub({ state: 'confirmed', consent_purpose: 'carrier' })).toMatch(/^Перевозчик подтвердил заявку/);
  });

  it('жильё: заезд и выезд; без названия и даты билета нет', () => {
    render(<RequestTicket view={{ ...base, kind: 'stay_request', consent_purpose: 'stay', tour: null, accommodation: 'Гостевой дом', check_out: '2026-12-08', participants: 3 }} />);
    const t = screen.getByRole('region', { name: 'Заявка' });
    expect(t.textContent).toContain('Заезд');
    expect(t.textContent).toContain('Выезд');
    expect(t.textContent).toContain('Гостей');
    cleanup();
    const { container } = render(<RequestTicket view={{ ...base, tour: null, date: null }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('колода мест', () => {
  const places = [
    { id: '1', title: 'Вулкан Горелый', typeLabel: 'Вулкан', description: 'Кратер с озером', imageUrl: null, urlSlug: 'vulkan-gorelyj' },
    { id: '2', title: 'Халактырский пляж', typeLabel: 'Пляж', description: '', imageUrl: null, urlSlug: null },
    { id: '3', title: 'Озеро Курильское', typeLabel: 'Озеро', description: '', imageUrl: null, urlSlug: 'kurilskoe' },
  ];

  it('жест: дрогнувший палец — не листание, сильный сдвиг или бросок — листание', () => {
    expect(swipeDirection(-30, -100)).toBe(0);
    expect(swipeDirection(-120, 0)).toBe(1);
    expect(swipeDirection(120, 0)).toBe(-1);
    expect(swipeDirection(-10, -900)).toBe(1);
  });

  it('ссылка — по ЧПУ, по id только без него', () => {
    expect(placeHref(places[0])).toBe('/places/vulkan-gorelyj');
    expect(placeHref(places[1])).toBe('/places/2');
  });

  it('верхняя карточка ведёт на место, кнопки листают, цены нет', async () => {
    render(<PlaceSwipeDeck places={places} />);
    const deck = screen.getByRole('group', { name: 'Места: листайте карточки' });
    expect(deck.querySelector('a')).toHaveAttribute('href', '/places/vulkan-gorelyj');
    expect(screen.getByText('1 из 3')).toBeInTheDocument();
    expect(deck.textContent).not.toMatch(/₽|Забронировать|от \d/);

    fireEvent.click(screen.getByRole('button', { name: 'Следующее место' }));
    await waitFor(() => expect(screen.getByText('2 из 3')).toBeInTheDocument(), { timeout: 2000 });
    expect(deck.querySelector('a')).toHaveAttribute('href', '/places/2');

    fireEvent.click(screen.getByRole('button', { name: 'Предыдущее место' }));
    await waitFor(() => expect(screen.getByText('1 из 3')).toBeInTheDocument(), { timeout: 2000 });
  });

  it('одно место — без кнопок листания; пусто — колоды нет', () => {
    render(<PlaceSwipeDeck places={[places[0]]} />);
    expect(screen.queryByRole('button', { name: 'Следующее место' })).toBeNull();
    cleanup();
    const { container } = render(<PlaceSwipeDeck places={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
