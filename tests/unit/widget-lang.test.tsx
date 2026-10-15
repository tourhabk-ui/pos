/**
 * Язык виджета партнёра — рендером (аудит 15.10, WID-lang, бриф W9).
 *
 * Владельца интересуют китайские туристы, а окно чата и форма заявки на сайте
 * партнёра говорили с любым посетителем только по-русски. Теперь строки
 * интерфейса — на языке браузера посетителя (`navigator.language`): `zh*` —
 * китайский, `en*` — английский, иначе русский. Что видит посетитель:
 *  - шапка, кнопка заявки, строка 112, отказы загрузки — на его языке;
 *  - подписи партнёра (приветствие, вступление формы) — как их задал
 *    партнёр; на его языке только наши заготовки на месте незаданного;
 *  - согласие на ПД — русский текст той же версии и пометка на языке
 *    посетителя, что согласие на русском, со ссылкой на политику;
 *  - язык окна уходит в запрос чата — серверные тексты (отказ модели, 400,
 *    блок 112) на том же языке; это держит widget-chat-route.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useParams: () => ({ partnerId: 'mestechko', slug: 'mestechko' }) }));

import WidgetPage from '@/app/widget/[partnerId]/page';
import LeadFormPage from '@/app/widget/lead-form/[slug]/page';
import { pickWidgetLang, WIDGET_TEXTS, type WidgetLang } from '@/lib/embed/widget-i18n';
import { LEAD_FORM_INTRO_DEFAULT } from '@/lib/embed/widget-style';
import { consentWording, PD_CONSENT_POLICY_URL, PD_CONSENT_VERSION } from '@/lib/legal/pd-consent';

/** Приветствие, заданное партнёром (по-русски), — не переводится. */
const OWN_GREETING = 'Здравствуйте! Спрашивайте про туры Местечка.';
const OWN_INTRO = 'Оставьте телефон — Местечко перезвонит.';

const CONFIG = {
  name: 'Местечко Камчатка',
  greeting: OWN_GREETING,
  accentColor: '#C2410A',
  logo: null,
};

/** Браузер посетителя на языке `tag`. */
function browserLanguage(tag: string) {
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(tag);
}

type Reply = { status: number; body: unknown } | 'network';

function stubFetch(partner: Reply, chat: Reply = { status: 200, body: { success: true, data: { answer: '有直升机游览。' } } }) {
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
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('язык окна по языку браузера', () => {
  it('zh* — китайский, en* — английский, прочее и пустое — русский', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK', 'ZH-cn', 'zh_CN']) expect(pickWidgetLang(tag)).toBe('zh');
    for (const tag of ['en', 'en-US', 'en-GB', 'EN-us']) expect(pickWidgetLang(tag)).toBe('en');
    for (const tag of ['ru', 'ru-RU', 'de-DE', 'ja-JP', 'eng', 'zhx', '', null, undefined]) expect(pickWidgetLang(tag)).toBe('ru');
  });
});

describe('словарь: каждая строка — на своём языке', () => {
  /** Все строки словаря языка; функции — с образцовыми аргументами. */
  function strings(lang: WidgetLang): Array<[string, string]> {
    return Object.entries(WIDGET_TEXTS[lang]).map(([k, v]) => [
      k,
      typeof v === 'function' ? String((v as (x: never) => string)('Partner' as never)) : String(v),
    ]);
  }
  // Имя языка — для промпта модели, оно по-русски намеренно.
  const PROMPT_ONLY = new Set(['promptLangName']);

  it('в английском и китайском нет русских строк (кроме имени языка для промпта)', () => {
    for (const lang of ['en', 'zh'] as const) {
      const cyr = strings(lang).filter(([k, v]) => !PROMPT_ONLY.has(k) && /[а-яё]/i.test(v)).map(([k]) => k);
      expect(cyr, `${lang}: строки по-русски`).toEqual([]);
    }
  });

  it('китайские строки — иероглифами, кроме марки и образца телефона', () => {
    const LATIN_OK = new Set(['brand', 'phonePlaceholder', 'promptLangName', 'consentNote', 'policyLink']);
    const latin = strings('zh').filter(([k, v]) => v && !LATIN_OK.has(k) && !/[\u4e00-\u9fff]/.test(v)).map(([k]) => k);
    expect(latin).toEqual([]);
    expect(WIDGET_TEXTS.zh.consentNote).toMatch(/[\u4e00-\u9fff]/);
    expect(WIDGET_TEXTS.zh.policyLink).toMatch(/[\u4e00-\u9fff]/);
  });

  it('112 — в строке подвала и во всех отказах, на каждом языке', () => {
    for (const lang of ['ru', 'en', 'zh'] as const) {
      const t = WIDGET_TEXTS[lang];
      for (const v of [t.emergency, t.loadFailed, t.sendFailed, t.chatFailed]) expect(v).toMatch(/(?<!\d)112(?!\d)/);
      // Отказ модели называет кнопку заявки так, как она подписана в окне.
      expect(t.chatFailed).toContain(t.leadButton);
    }
  });
});

/** Ожидания по языку: что посетитель видит в окне чата. */
const CASES = [
  { tag: 'zh-CN', lang: 'zh', emergency: '紧急求助 — 112', lead: '留下申请' },
  { tag: 'en-US', lang: 'en', emergency: 'Emergency — 112', lead: 'Leave a request' },
  { tag: 'ru-RU', lang: 'ru', emergency: 'Экстренно — 112', lead: 'Оставить заявку' },
  { tag: 'de-DE', lang: 'ru', emergency: 'Экстренно — 112', lead: 'Оставить заявку' },
] as const;

describe.each(CASES)('окно чата: браузер $tag → $lang', ({ tag, lang, emergency, lead }) => {
  const t = WIDGET_TEXTS[lang];

  it('шапка, кнопка заявки, строка 112 и подпись — на языке посетителя', async () => {
    browserLanguage(tag);
    stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    const { container } = render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');

    // Буквально — как это прочтёт посетитель.
    expect(screen.getByText(emergency)).toBeVisible();
    expect(screen.getByRole('button', { name: lead })).toBeInTheDocument();

    expect(screen.getByText(t.assistantLabel)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.leadButton })).toBeInTheDocument();
    expect(screen.getByText(t.emergency)).toBeVisible();
    expect(screen.getByRole('link', { name: t.brand })).toHaveAttribute('href', 'https://vedarai.ru');
    expect(screen.getByLabelText(t.inputLabel)).toHaveAttribute('placeholder', t.inputPlaceholder);
    expect(screen.getByRole('button', { name: t.send })).toBeInTheDocument();
    // Окно объявляет свой язык — диктор и перенос строк идут по нему.
    expect(container.querySelector('[data-theme="light"]')).toHaveAttribute('lang', lang);
    // 112 — строкой, не ссылкой: набор 112 только у EmergencyAction (#887).
    expect(container.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);

    // Приветствие партнёра — его словами, не переведено.
    expect(screen.getByText(OWN_GREETING)).toBeInTheDocument();

    // Форма заявки внутри окна: заголовок кадра и возврат — на том же языке.
    fireEvent.click(screen.getByRole('button', { name: t.leadButton }));
    expect(screen.getByTitle(t.leadFrameTitle('Местечко Камчатка')).tagName).toBe('IFRAME');
    expect(screen.getByRole('button', { name: new RegExp(t.backToChat) })).toBeInTheDocument();
    expect(screen.getByText(t.emergency)).toBeVisible();
  });

  it('ошибки загрузки — на языке посетителя, с тремя исходами и строкой 112', async () => {
    browserLanguage(tag);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const loading = render(<WidgetPage />);
    expect(screen.getByText(t.loading)).toBeInTheDocument();
    expect(screen.getByText(t.emergency)).toBeVisible();
    loading.unmount();

    stubFetch({ status: 404, body: { success: false, error: 'Виджет партнёра не найден или выключен' } });
    const notFound = render(<WidgetPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.notFound);
    expect(screen.getByText(t.emergency)).toBeVisible();
    notFound.unmount();

    stubFetch('network');
    render(<WidgetPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.loadFailed);
    expect(within(alert).queryByText(t.notFound)).toBeNull();
    expect(screen.getByText(t.emergency)).toBeVisible();
  });

  it('язык окна уходит в запрос чата; отказ сети — на языке посетителя', async () => {
    browserLanguage(tag);
    const fetchMock = stubFetch({ status: 200, body: { success: true, data: CONFIG } });
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.change(screen.getByLabelText(t.inputLabel), { target: { value: '有直升机吗？' } });
    fireEvent.click(screen.getByRole('button', { name: t.send }));
    await screen.findByText('有直升机游览。');
    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/widget/chat'));
    const sent = JSON.parse(String((chatCall?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent.lang).toBe(lang);
    // Под ответом — предложение заявки на том же языке.
    expect(screen.getByText(t.leadPrompt)).toBeInTheDocument();

    stubFetch({ status: 200, body: { success: true, data: CONFIG } }, 'network');
    fireEvent.change(screen.getByLabelText(t.inputLabel), { target: { value: 'SOS' } });
    fireEvent.click(screen.getByRole('button', { name: t.send }));
    expect(await screen.findByText(t.sendFailed)).toBeInTheDocument();
  });
});

describe('окно чата: заготовка приветствия переводится, слова партнёра — нет', () => {
  it('партнёр приветствия не задал — наша заготовка на языке посетителя', async () => {
    browserLanguage('zh-CN');
    stubFetch({ status: 200, body: { success: true, data: { ...CONFIG, greeting: WIDGET_TEXTS.ru.defaultGreeting(CONFIG.name) } } });
    render(<WidgetPage />);
    expect(await screen.findByText(WIDGET_TEXTS.zh.defaultGreeting(CONFIG.name))).toBeInTheDocument();
    expect(screen.queryByText(WIDGET_TEXTS.ru.defaultGreeting(CONFIG.name))).toBeNull();
  });

  it('ответ сервера на 400 показан как есть: язык ему задало окно', async () => {
    browserLanguage('zh-CN');
    stubFetch(
      { status: 200, body: { success: true, data: CONFIG } },
      { status: 400, body: { success: false, error: WIDGET_TEXTS.zh.errMessageEmpty } },
    );
    render(<WidgetPage />);
    await screen.findByText('Местечко Камчатка');
    fireEvent.change(screen.getByLabelText(WIDGET_TEXTS.zh.inputLabel), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: WIDGET_TEXTS.zh.send }));
    expect(await screen.findByText(`${WIDGET_TEXTS.zh.errMessageEmpty}.`)).toBeInTheDocument();
  });
});

describe.each(CASES)('форма заявки: браузер $tag → $lang', ({ tag, lang }) => {
  const t = WIDGET_TEXTS[lang];

  function serveForm(formIntro: string, leads: Reply | ((body: Record<string, unknown>) => Reply) = { status: 201, body: { success: true, id: 'lead-1' } }) {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/widget/partner/')) {
        return new Response(JSON.stringify({ success: true, data: { name: CONFIG.name, accentColor: '#C2410A', logo: null, formIntro } }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      const reply = typeof leads === 'function' ? leads(body) : leads;
      if (reply === 'network') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }));
    return sent;
  }

  function fillAndSend() {
    fireEvent.change(screen.getByPlaceholderText(t.namePlaceholder), { target: { value: 'Li Wei' } });
    fireEvent.change(screen.getByPlaceholderText(t.phonePlaceholder), { target: { value: '+8613800000000' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: t.submit }));
  }

  it('подписи полей и кнопка — на языке посетителя; вступление партнёра — как есть', async () => {
    browserLanguage(tag);
    serveForm(OWN_INTRO);
    const { container } = render(<LeadFormPage />);
    await screen.findByText(CONFIG.name);
    expect(screen.getByText(OWN_INTRO)).toBeInTheDocument();
    expect(screen.getByText(t.nameLabel)).toBeInTheDocument();
    expect(screen.getByText(t.phoneLabel)).toBeInTheDocument();
    expect(screen.getByText(t.commentLabel)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.commentPlaceholder)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.submit })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('lang', lang);
  });

  it('вступление не задано — наша заготовка на языке посетителя', async () => {
    browserLanguage(tag);
    serveForm(LEAD_FORM_INTRO_DEFAULT);
    render(<LeadFormPage />);
    await screen.findByText(CONFIG.name);
    expect(screen.getByText(t.formIntroDefault)).toBeInTheDocument();
    if (lang !== 'ru') expect(screen.queryByText(LEAD_FORM_INTRO_DEFAULT)).toBeNull();
  });

  it('согласие — русский текст той же версии; на en/zh — пометка и ссылка на политику', async () => {
    browserLanguage(tag);
    const sent = serveForm(OWN_INTRO);
    render(<LeadFormPage />);
    await screen.findByText(CONFIG.name);

    // Текст согласия — ровно тот, чья версия записывается сервером.
    const wording = consentWording('operator');
    expect(wording.version).toBe(PD_CONSENT_VERSION);
    const checkbox = screen.getByRole('checkbox');
    const label = checkbox.closest('label');
    expect(label).toHaveTextContent(wording.text);
    // Объявлен русским — и в китайском окне.
    expect(label?.closest('[lang]')).toHaveAttribute('lang', 'ru');

    if (lang === 'ru') {
      expect(screen.queryByText(WIDGET_TEXTS.en.consentNote, { exact: false })).toBeNull();
      expect(screen.queryByText(WIDGET_TEXTS.zh.consentNote, { exact: false })).toBeNull();
    } else {
      expect(screen.getByText(t.consentNote, { exact: false })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: t.policyLink })).toHaveAttribute('href', PD_CONSENT_POLICY_URL);
    }

    // Согласие уходит тем же полем, что и раньше.
    fillAndSend();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].pd_consent).toBe(true);
    expect(await screen.findByText(t.successTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.close })).toBeInTheDocument();
  });

  it('отказ сети — на языке посетителя', async () => {
    browserLanguage(tag);
    serveForm(OWN_INTRO, 'network');
    render(<LeadFormPage />);
    await screen.findByText(CONFIG.name);
    fillAndSend();
    expect(await screen.findByText(t.networkFailed)).toBeInTheDocument();
  });

  it('отказ сервера: русское окно — слова сервера, en/zh — отказ на языке посетителя', async () => {
    browserLanguage(tag);
    serveForm(OWN_INTRO, { status: 400, body: { success: false, error: 'Укажите телефон' } });
    render(<LeadFormPage />);
    await screen.findByText(CONFIG.name);
    fillAndSend();
    if (lang === 'ru') {
      expect(await screen.findByText('Укажите телефон')).toBeInTheDocument();
    } else {
      expect(await screen.findByText(t.submitFailed)).toBeInTheDocument();
      expect(screen.queryByText('Укажите телефон')).toBeNull();
    }
  });
});

describe('форма заявки: настройки не загрузились — шапка на языке посетителя', () => {
  it('китайский браузер — запасной заголовок и заготовка вступления по-китайски', async () => {
    browserLanguage('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<LeadFormPage />);
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(screen.getByText(WIDGET_TEXTS.zh.formTitleFallback)).toBeInTheDocument();
    expect(screen.getByText(WIDGET_TEXTS.zh.formIntroDefault)).toBeInTheDocument();
  });
});
