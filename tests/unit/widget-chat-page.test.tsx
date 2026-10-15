/**
 * Окно чата виджета партнёра — рендером (аудит 15.10, WID-safety).
 *
 * Что видит посетитель сайта партнёра:
 *  - «Оставить заявку» есть всегда в шапке и под ответом помощника и
 *    открывает ту же форму `/widget/lead-form/<slug>` (телефон, согласие,
 *    адресат-партнёр) — лида из самого чата больше нет;
 *  - строка «Экстренно — 112» видна на любом экране окна — текстом, не ссылкой
 *    tel:112; своей SOS-кнопки нет;
 *  - отказы по-русски, и «не найден» отличается от «не загрузился»;
 *  - форма, открытая из окна чата, получает хост и путь страницы партнёра
 *    своими параметрами адреса — как от lead.js, а не только через
 *    document.referrer (аудит 15.10, W3-widget: у обещания в шапках
 *    readWidgetOriginParams и формы не было производителя).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Оба параметра: окно чата читает partnerId, форма заявки — slug (сквозной
// тест ниже рендерит обе страницы).
vi.mock('next/navigation', () => ({ useParams: () => ({ partnerId: 'mestechko', slug: 'mestechko' }) }));

import WidgetPage from '@/app/widget/[partnerId]/page';
import LeadFormPage from '@/app/widget/lead-form/[slug]/page';

const CONFIG = {
  name: 'Местечко Камчатка',
  greeting: 'Здравствуйте! Спрашивайте про туры Местечка.',
  accentColor: '#C2410A',
  logo: null,
};

type Reply = { status: number; body: unknown } | 'network';

function stubFetch(partner: Reply, chat: Reply = { status: 200, body: { success: true, data: { answer: 'Есть вертолётная экскурсия.' } } }) {
  const fetchMock = vi.fn(async (url: string) => {
    const reply = url.includes('/api/widget/partner/') ? partner : chat;
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('окно чата: заявка — формой', () => {
  it('кнопка в шапке открывает форму заявки партнёра в этом же окне', async () => {
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');

    const buttons = screen.getAllByRole('button', { name: 'Оставить заявку' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);

    const frame = screen.getByTitle('Заявка партнёру Местечко Камчатка');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('/widget/lead-form/mestechko');

    // Обратно — без потери разговора.
    fireEvent.click(screen.getByRole('button', { name: /Вернуться в чат/ }));
    expect(screen.queryByTitle('Заявка партнёру Местечко Камчатка')).toBeNull();
    expect(screen.getByText(CONFIG.greeting)).toBeInTheDocument();
  });

  it('после ответа помощника заявка предложена и под ответом', async () => {
    const fetchMock = stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');

    fireEvent.change(screen.getByLabelText('Сообщение помощнику'), { target: { value: 'Есть вертолёт?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Есть вертолётная экскурсия.');

    expect(screen.getAllByRole('button', { name: 'Оставить заявку' })).toHaveLength(2);
    // Приветствие партнёра в историю разговора не уходит.
    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/widget/chat'));
    const sent = JSON.parse(String((chatCall?.[1] as RequestInit).body)) as { history: unknown[]; message: string };
    expect(sent.history).toEqual([]);
    expect(sent.message).toBe('Есть вертолёт?');
  });

  it('«Закрыть» формы (th:close от вложенного окна) возвращает в чат', async () => {
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.click(screen.getByRole('button', { name: 'Оставить заявку' }));
    const frame = screen.getByTitle('Заявка партнёру Местечко Камчатка') as HTMLIFrameElement;

    // Чужое окно (сайт партнёра, любой другой кадр) не командует чатом.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: 'th:close', source: window }));
    });
    expect(screen.getByTitle('Заявка партнёру Местечко Камчатка')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: 'th:close', source: frame.contentWindow }));
    });
    await waitFor(() => expect(screen.queryByTitle('Заявка партнёру Местечко Камчатка')).toBeNull());
  });
});

describe('окно чата: форма заявки несёт хост и путь страницы партнёра', () => {
  /** Окно чата, как его открыл embed.js на странице партнёра. */
  async function openLeadFormFrom(chatAddress: string): Promise<string> {
    window.history.replaceState({}, '', chatAddress);
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.click(screen.getByRole('button', { name: 'Оставить заявку' }));
    return screen.getByTitle('Заявка партнёру Местечко Камчатка').getAttribute('src') ?? '';
  }

  it('хост и путь из адреса окна чата — в адресе формы', async () => {
    const src = await openLeadFormFrom('/widget/mestechko?theme=light&host=mestechkokam.ru&path=/tours');
    expect(src).toBe('/widget/lead-form/mestechko?host=mestechkokam.ru&path=%2Ftours');
  });

  it('хоста в адресе окна нет — форма без host и path (путь без хоста ни о чём не говорит)', async () => {
    const src = await openLeadFormFrom('/widget/mestechko?theme=light&path=/tours');
    expect(src).toBe('/widget/lead-form/mestechko');
  });

  it('хост без пути — только хост', async () => {
    const src = await openLeadFormFrom('/widget/mestechko?host=mestechkokam.ru');
    expect(src).toBe('/widget/lead-form/mestechko?host=mestechkokam.ru');
  });

  it('сквозь стык: заявка формы, открытой из чата, несёт хост и путь без реферера', async () => {
    const src = await openLeadFormFrom('/widget/mestechko?host=mestechkokam.ru&path=/tours');
    cleanup();
    // Форма — в своём окне по адресу, который дал ей чат. Реферера нет:
    // происхождение доходит параметрами, а не через document.referrer.
    window.history.replaceState({}, '', src);
    expect(document.referrer).toBe('');
    const leads: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/widget/partner/')) {
        return new Response(JSON.stringify({ success: true, data: { name: 'Местечко Камчатка', accentColor: '#C2410A', logo: null } }));
      }
      leads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true, id: 'lead-1' }), { status: 201 });
    }));
    render(<LeadFormPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.change(screen.getByPlaceholderText('Иван Иванов'), { target: { value: 'Иван' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79000000001' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    await waitFor(() => expect(leads).toHaveLength(1));
    expect((leads[0].source_data as Record<string, unknown>).widget_origin).toEqual({ host: 'mestechkokam.ru', path: '/tours' });
  });
});

describe('окно чата: 112', () => {
  it('строка «Экстренно — 112» видна в чате и в форме заявки', async () => {
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');

    expect(screen.getByText('Экстренно — 112')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Оставить заявку' }));
    expect(screen.getByText('Экстренно — 112')).toBeVisible();
  });

  it('ссылки tel:112 в окне нет: набор 112 — только у EmergencyAction (#887)', async () => {
    // Ревью 15.10: сырая ссылка на 112 вне EmergencyAction — вторая
    // реализация SOS, она расходится с ним офлайн-веткой. В окне — строка.
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    const { container } = render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');

    const telLinks = () => container.querySelectorAll('a[href^="tel:"]');
    expect(telLinks()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /112/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Оставить заявку' }));
    expect(telLinks()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /112/ })).toBeNull();
  });

  it('своей SOS-кнопки в окне нет (SOS — только EmergencyAction, §11)', async () => {
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    expect(screen.queryByRole('button', { name: /SOS|СОС/i })).toBeNull();
  });

  it('ответ не пришёл — сказано словами и с 112', async () => {
    stubFetch({ status: 200, body: { success: true, data: CONFIG } }, 'network');
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.change(screen.getByLabelText('Сообщение помощнику'), { target: { value: 'Помогите' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText(/Не получилось получить ответ.*112/)).toBeInTheDocument();
  });
});

describe('окно чата: отказы по-русски, три исхода', () => {
  it('виджет не найден или выключен (404)', async () => {
    stubFetch({ status: 404, body: { success: false, error: 'Partner not found' } });
    render(<WidgetPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Чат этого партнёра не найден или выключен.');
    expect(within(alert).queryByText(/Partner not found|Failed to load/)).toBeNull();
  });

  it('сеть или сбой — «не загрузился», а не «не найден»', async () => {
    stubFetch('network');
    render(<WidgetPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Чат не загрузился/);
    expect(alert).not.toHaveTextContent(/не найден/);
  });
});
