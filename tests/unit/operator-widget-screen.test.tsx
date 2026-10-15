/**
 * Экран «Виджет на ваш сайт» в кабинете оператора и отчёт в карточке
 * оператора админки (аудит 15.10, находка WID-screens, W7) — рендером, с
 * моком fetch: что видит человек.
 *
 * Держит:
 *  - оба кода вставки — чат (embed.js) и кнопка заявки (lead.js) — с slug
 *    партнёра, и это те самые коды, которые перепись узнаёт на сайте
 *    (detectWidgetScripts): код, который проба не нашла бы, — красный;
 *  - домены — только чтение, правка — через администратора, так и сказано;
 *  - отчёт за 30 дней с границами словами: загрузки — «до N», открытия —
 *    «не меньше N», загрузки чата — «не измеряется»;
 *  - стоит ли код на сайте — «не проверено», пока пробы нет;
 *  - отказ части отчёта — «не загрузилось» у ЭТИХ строк, а не ноль (§4.0);
 *  - отказ целиком — «не загрузились» с причиной и «Повторить», а не пустой
 *    отчёт; выключенный виджет — без кода, со словами, кто включает;
 *  - админка: оба кода в карточке, отчёт по кнопке, проба — по своей кнопке
 *    и только тогда «стоит ли код» перестаёт быть «не проверено».
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
// Панель Tilda грузит свои ключи при монтировании — к виджету отношения не имеет.
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import WidgetClient from '@/app/hub/operator/widget/_WidgetClient';
import { OperatorCard } from '@/app/hub/admin/operators/_OperatorsClient';
import { widgetSnippets } from '@/lib/embed/widget-snippets';
import { detectWidgetScripts } from '@/lib/analytics/widget-census';
import { OPERATOR_MENU } from '@/components/operator/operator-menu';

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

/** Ответ GET /api/hub/operator/widget — форма widgetReportForPartner. */
function reportBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      window: { telemetry_days: 30, activity_days: [30, 90] },
      partner: { slug: 'mestechko', name: 'Местечко Камчатка', widget_enabled: true, widget_domains: ['mestechkokam.ru'] },
      telemetry_30d: {
        form: { served: 129, opened: 10 },
        chat: { served: null, opened: 5 },
        by_host: [
          { host: 'mestechkokam.ru', host_check: 'listed', widget: 'form', served: 124, opened: 9, last_day: '2026-10-15' },
          { host: 'copy.example', host_check: 'unlisted', widget: 'form', served: 5, opened: 1, last_day: '2026-10-10' },
          { host: 'mestechkokam.ru', host_check: 'listed', widget: 'chat', served: null, opened: 5, last_day: '2026-10-15' },
        ],
      },
      chat_sessions: {
        sessions_30d: 4, sessions_90d: 6, user_messages_30d: 9, user_messages_90d: 13,
        listed_90d: 3, unlisted_90d: 0, not_sent_90d: 1, origin_not_recorded_90d: 2, last_at: '2026-10-15 10:00:00+00',
      },
      form_leads: {
        leads_30d: 2, leads_90d: 5, self_90d: 1,
        listed_90d: 1, unlisted_90d: 0, not_sent_90d: 0, origin_not_recorded_90d: 4, last_at: null,
      },
      chat_pseudo_leads: { pseudo_30d: 0, pseudo_90d: 1, handed_to_other_operators_90d: 1 },
      site_probe: null,
      failed_measures: [],
      notes: [],
      ...over,
    },
  };
}

/** Значение строки отчёта по её ключу. */
function lineValue(key: string): string {
  const row = document.querySelector(`[data-line="${key}"]`);
  if (!row) throw new Error(`строки ${key} нет`);
  return row.querySelectorAll('dd')[0]!.textContent!.trim();
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('кабинет оператора: виджет на ваш сайт', () => {
  it('пункт меню есть, команде открыт', () => {
    const item = OPERATOR_MENU.find((i) => i.href === '/hub/operator/widget');
    expect(item?.access).toBe('team');
  });

  it('оба кода с slug партнёра — и перепись узнала бы их на сайте', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody()));
    render(<WidgetClient />);
    const chat = await screen.findByLabelText('Код вставки: Чат с Кузьмичом');
    const form = screen.getByLabelText('Код вставки: Кнопка заявки');
    const want = widgetSnippets('mestechko')!;
    expect(chat.textContent).toBe(want.chat);
    expect(form.textContent).toBe(want.form);
    expect(chat.textContent).toContain('/widget/embed.js');
    expect(chat.textContent).toContain('data-partner-id="mestechko"');
    expect(form.textContent).toContain('/api/widget/lead.js?partner=mestechko');
    // Код, вставленный на главную, проба переписи узнаёт как оба виджета.
    const page = `<html><body>${chat.textContent}${form.textContent}</body></html>`;
    expect(detectWidgetScripts(page, 'mestechko').sort()).toEqual(['chat', 'form']);
    // Чужой партнёр с общим началом slug свой код здесь не нашёл бы.
    expect(detectWidgetScripts(page, 'mestechko-2')).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/hub/operator/widget');
  });

  it('домены — только чтение, правка через администратора', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody()));
    render(<WidgetClient />);
    const list = await screen.findByRole('list', { name: 'Домены из списка' });
    expect(within(list).getByText('mestechkokam.ru')).toBeTruthy();
    expect(document.body.textContent).toMatch(/Список ведёт администратор Ведара/);
    expect(document.body.textContent).toMatch(/ничего не запирает/);
    // Ни поля ввода, ни кнопки правки доменов у оператора нет.
    expect(document.querySelector('textarea, input')).toBeNull();
    expect(screen.queryByRole('button', { name: /Изменить|Сохранить/ })).toBeNull();
  });

  it('отчёт за 30 дней: границы словами, загрузки чата не измеряются', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody()));
    render(<WidgetClient />);
    await screen.findByRole('heading', { name: /За 30 дней/ });
    expect(lineValue('form_served')).toBe('до 129');
    expect(lineValue('form_opened')).toBe('не меньше 10');
    expect(lineValue('chat_served')).toBe('не измеряется');
    expect(lineValue('chat_opened')).toBe('не меньше 5');
    expect(lineValue('chat_sessions')).toBe('4');
    expect(lineValue('form_leads')).toBe('2');
    const hosts = screen.getByRole('list', { name: 'По адресам страниц' });
    expect(hosts.textContent).toContain('copy.example — не в списке доменов');
    expect(document.body.textContent).not.toMatch(/не загрузилось/);
  });

  it('стоит ли код на сайте — «не проверено», пока пробы нет', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody()));
    render(<WidgetClient />);
    await screen.findByRole('heading', { name: /За 30 дней/ });
    expect(document.querySelector('[data-presence]')!.textContent).toBe('не проверено');
    expect(document.body.textContent).toMatch(/косвенный признак, а не проверка/);
  });

  it('отказ части — «не загрузилось» у её строк, а не ноль; прочие строки на месте', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody({
      telemetry_30d: null,
      form_leads: null,
      failed_measures: [{ measure: 'widget_daily', sqlstate: '42P01' }, { measure: 'form_leads', sqlstate: '57014' }],
    })));
    render(<WidgetClient />);
    await screen.findByRole('heading', { name: /За 30 дней/ });
    for (const key of ['form_served', 'form_opened', 'chat_opened', 'form_leads']) {
      expect(lineValue(key), key).toBe('не загрузилось');
    }
    expect(lineValue('chat_sessions')).toBe('4');
    expect(document.body.textContent).toMatch(/Часть отчёта не загрузилась/);
    // Оператору SQLSTATE не показывается — достаточно строк.
    expect(document.body.textContent).not.toContain('42P01');
  });

  it('часть неожиданной формы — тоже «не загрузилось», а не ноль', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody({ chat_sessions: { sessions_30d: 'много' } })));
    render(<WidgetClient />);
    await screen.findByRole('heading', { name: /За 30 дней/ });
    expect(lineValue('chat_sessions')).toBe('не загрузилось');
  });

  it('виджет выключен — кода нет, сказано, кто включает', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody({
      partner: { slug: 'mestechko', name: 'Местечко Камчатка', widget_enabled: false, widget_domains: [] },
    })));
    render(<WidgetClient />);
    expect(await screen.findByText('Виджет выключен')).toBeTruthy();
    expect(screen.queryByLabelText(/Код вставки/)).toBeNull();
    expect(document.body.textContent).toMatch(/Включает его администратор Ведара/);
    expect(screen.getAllByRole('link', { name: 'info@vedarai.ru' })[0].getAttribute('href')).toBe('mailto:info@vedarai.ru');
    // Пустой список доменов — тоже только чтение: слова, а не поле правки.
    expect(screen.getByText('Не указаны.')).toBeTruthy();
    expect(document.querySelector('textarea, input')).toBeNull();
  });

  it('отказ сервера — причина и «Повторить», а не пустой отчёт; повтор зовёт роут снова', async () => {
    fetchMock.mockImplementationOnce(() => json(503, { success: false, error: 'Не удалось загрузить данные виджета — попробуйте позже' }));
    render(<WidgetClient />);
    expect(await screen.findByText('Данные виджета не загрузились')).toBeTruthy();
    expect(screen.getByText('Не удалось загрузить данные виджета — попробуйте позже')).toBeTruthy();
    expect(document.querySelector('[data-line]')).toBeNull();
    fetchMock.mockImplementationOnce(() => json(200, reportBody()));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByRole('heading', { name: /За 30 дней/ });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('связи нет — «нет связи с сервером»', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<WidgetClient />);
    expect(await screen.findByText('нет связи с сервером')).toBeTruthy();
  });

  it('буфер обмена закрыт — «не скопировалось», а не галочка', async () => {
    fetchMock.mockImplementation(() => json(200, reportBody()));
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<WidgetClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Скопировать код: Чат с Кузьмичом' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Не скопировалось/);
    expect(writeText).toHaveBeenCalledWith(widgetSnippets('mestechko')!.chat);
  });
});

// ─── Админка: карточка оператора ───────────────────────────────────────────

type Op = Parameters<typeof OperatorCard>[0]['op'];
const OP: Op = {
  id: '0aaa4f05-0000-4000-8000-000000000001',
  company_name: 'Местечко Камчатка',
  category: 'operator',
  description: '',
  profile_status: 'pending',
  applied_at: null,
  is_verified: true,
  is_public: true,
  profile_review_comment: null,
  email: null,
  contact_name: null,
  registered_at: null,
  has_account: false,
  external_source: null,
  application_id: null,
  contact_phone: null,
  contact_email: null,
  inn: null,
  application_status: null,
  reviewed_at: null,
  telegram_chat_id: null,
  has_telegram: false,
  has_max: false,
  slug: 'mestechko',
  widget_enabled: true,
  widget_domains: ['mestechkokam.ru'],
};

describe('админка: оба кода и тот же отчёт в карточке оператора', () => {
  const renderCard = () => render(
    <OperatorCard op={OP} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />,
  );

  it('оба кода — те же, что у оператора; отчёт не грузится, пока не попросили', () => {
    renderCard();
    const want = widgetSnippets('mestechko')!;
    expect(screen.getByLabelText('Код вставки: Чат с Кузьмичом').textContent).toBe(want.chat);
    expect(screen.getByLabelText('Код вставки: Кнопка заявки').textContent).toBe(want.form);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отчёт по кнопке; проба — по своей, и только тогда «стоит ли код» не «не проверено»', async () => {
    fetchMock.mockImplementation((url: string) => (url.includes('probe_sites=1')
      ? json(200, reportBody({
        site_probe: [{ domain: 'mestechkokam.ru', url: 'https://mestechkokam.ru/', outcome: 'not_found', scripts: [], http_status: 200, reason: null }],
      }))
      : json(200, reportBody({ failed_measures: [{ measure: 'chat_pseudo_leads', sqlstate: '57014' }] }))));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Отчёт за 30 дней/ }));
    await waitFor(() => expect(document.querySelector('[data-presence]')).not.toBeNull());
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/admin/operators/${OP.id}/widget/report`);
    expect(lineValue('form_served')).toBe('до 129');
    expect(document.querySelector('[data-presence]')!.textContent).toBe('не проверено');
    // Админке названа несостоявшаяся часть с SQLSTATE.
    expect(document.body.textContent).toContain('chat_pseudo_leads (57014)');

    fireEvent.click(screen.getByRole('button', { name: /Проверить главные сейчас/ }));
    await waitFor(() => expect(document.querySelector('[data-presence]')!.textContent).toBe('на главной нет'));
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/admin/operators/${OP.id}/widget/report?probe_sites=1`);
    expect(document.body.textContent).toMatch(/mestechkokam\.ru — на главной нет/);
  });

  it('отчёт не загрузился — причина видна, «Повторить» есть', async () => {
    fetchMock.mockImplementation(() => json(503, { error: 'Отчёт о виджете не загрузился — ошибка базы' }));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Отчёт за 30 дней/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('ошибка базы');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
});
