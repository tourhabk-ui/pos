/**
 * lib/embed/widget-i18n.ts — язык виджета партнёра: один словарь на окно чата
 * (`app/widget/[partnerId]/page.tsx`), форму заявки
 * (`app/widget/lead-form/[slug]/page.tsx`) и фиксированные тексты роута
 * `POST /api/widget/chat`.
 *
 * Аудит 15.10, WID-lang (W9). Владельца интересуют китайские туристы, а окно
 * на сайте партнёра говорило с любым посетителем только по-русски, и ошибки
 * загрузки отдавало по-английски. Теперь строки интерфейса — на языке браузера
 * посетителя: китайский (`zh*`), английский (`en*`), иначе русский.
 *
 * Чего словарь НЕ делает, и почему:
 *  - подписи партнёра (`greeting`, `formIntro`, `buttonText` из
 *    `widget_config`) не переводит — это слова партнёра на его витрине (§0
 *    CLAUDE.md); переводятся только НАШИ заготовки на месте незаданного;
 *  - согласие на обработку ПД не переводит — это юридический текст с версией
 *    (lib/legal/pd-consent). Машинный перевод был бы вторым текстом без своей
 *    версии; посетителю на en/zh форма показывает русский текст согласия и
 *    пометку на его языке, что согласие — на русском (`consentNote`);
 *  - блок 112 при признаках ЧП живёт в lib/safety/sos-detector (`withSosBlock`
 *    с языком): это текст модуля безопасности, а не оформления.
 *
 * Модуль чистый: окно — клиентский код, и серверное сюда тянуть нельзя.
 * Сторожа: tests/unit/widget-lang.test.tsx (рендер окна и формы на трёх языках,
 * вызов роута с `lang`).
 */
import { LEAD_FORM_INTRO_DEFAULT } from '@/lib/embed/widget-style';

export const WIDGET_LANGS = ['ru', 'en', 'zh'] as const;
export type WidgetLang = (typeof WIDGET_LANGS)[number];

export function isWidgetLang(v: unknown): v is WidgetLang {
  return typeof v === 'string' && (WIDGET_LANGS as readonly string[]).includes(v);
}

/**
 * Язык окна по языку браузера (`navigator.language`, BCP 47): `zh`, `zh-CN`,
 * `zh-Hant-TW` — китайский; `en`, `en-US` — английский; всё прочее, пустое и
 * нераспознанное — русский, язык платформы.
 */
export function pickWidgetLang(tag: string | null | undefined): WidgetLang {
  const t = (tag ?? '').trim().toLowerCase();
  if (/^zh(?:[-_]|$)/.test(t)) return 'zh';
  if (/^en(?:[-_]|$)/.test(t)) return 'en';
  return 'ru';
}

export interface WidgetTexts {
  /* ── окно чата ── */
  loading: string;
  /** Чат не найден или выключен (404) — не то же, что «не загрузился». */
  notFound: string;
  loadFailed: string;
  sendFailed: string;
  /** Кнопка заявки в окне чата; её же имя модель называет в ответе. */
  leadButton: string;
  assistantLabel: string;
  backToChat: string;
  leadFrameTitle: (partnerName: string) => string;
  typing: string;
  leadPrompt: string;
  inputPlaceholder: string;
  inputLabel: string;
  send: string;
  /** Строка 112 в подвале окна — текстом, не ссылкой tel:112 (#887). */
  emergency: string;
  poweredByBefore: string;
  brand: string;
  poweredByAfter: string;
  /** Наша заготовка приветствия, когда партнёр своего не задал. */
  defaultGreeting: (partnerName: string) => string;
  /** Как называть язык посетителя в промпте модели (по-русски). */
  promptLangName: string;

  /* ── форма заявки ── */
  formTitleFallback: string;
  /** Наша заготовка вступления формы, когда партнёр своего не задал. */
  formIntroDefault: string;
  nameLabel: string;
  namePlaceholder: string;
  phoneLabel: string;
  phonePlaceholder: string;
  commentLabel: string;
  commentPlaceholder: string;
  consentRequired: string;
  /** Пометка рядом с русским согласием на en/zh; на ru — пусто. */
  consentNote: string;
  policyLink: string;
  submitFailed: string;
  networkFailed: string;
  submit: string;
  submitting: string;
  successTitle: string;
  successText: string;
  close: string;

  /* ── роут POST /api/widget/chat ── */
  /** Отказ всех моделей — честное «не смог», а не пустота (§4.0). */
  chatFailed: string;
  errPartnerMissing: string;
  errPartnerInvalid: string;
  errSessionMissing: string;
  errSessionInvalid: string;
  errMessageEmpty: string;
  errMessageTooLong: (max: number) => string;
  errHistoryItemTooLong: (max: number) => string;
  errHistoryTooMany: (max: number) => string;
  errHistoryTooLong: (max: number) => string;
  errInvalid: string;
  errServer: string;
}

const RU: WidgetTexts = {
  loading: 'Загрузка...',
  notFound: 'Чат этого партнёра не найден или выключен.',
  loadFailed: 'Чат не загрузился — проверьте связь и обновите страницу. Экстренно — 112.',
  sendFailed: 'Не получилось получить ответ — попробуйте ещё раз. Экстренно — 112.',
  leadButton: 'Оставить заявку',
  assistantLabel: 'Помощник Ведар AI',
  backToChat: 'Вернуться в чат',
  leadFrameTitle: (name) => `Заявка партнёру ${name}`,
  typing: 'Печатает...',
  leadPrompt: 'Хотите, чтобы партнёр подобрал поездку и позвонил?',
  inputPlaceholder: 'Напишите сообщение...',
  inputLabel: 'Сообщение помощнику',
  send: 'Отправить',
  emergency: 'Экстренно — 112',
  poweredByBefore: 'Работает на ',
  brand: 'Ведар AI',
  poweredByAfter: '',
  defaultGreeting: (name) => `Привет! Я AI-помощник ${name}. Чем могу помочь?`,
  promptLangName: 'русский',

  formTitleFallback: 'Заявка на тур',
  formIntroDefault: LEAD_FORM_INTRO_DEFAULT,
  nameLabel: 'Ваше имя *',
  namePlaceholder: 'Иван Иванов',
  phoneLabel: 'Телефон *',
  phonePlaceholder: '+7 900 000-00-00',
  commentLabel: 'Что интересует? (необязательно)',
  commentPlaceholder: 'Маршрут, даты, количество человек...',
  consentRequired: 'Необходимо согласие на обработку персональных данных',
  consentNote: '',
  policyLink: '',
  submitFailed: 'Ошибка. Попробуйте ещё раз.',
  networkFailed: 'Ошибка соединения. Попробуйте ещё раз.',
  submit: 'Отправить заявку',
  submitting: 'Отправляем...',
  successTitle: 'Заявка принята!',
  successText: 'Менеджер свяжется с вами в ближайшее время.',
  close: 'Закрыть',

  chatFailed: 'Помощник сейчас не смог ответить — это сбой на стороне Ведара. Попробуйте ещё раз '
    + 'или оставьте заявку кнопкой «Оставить заявку» — партнёр ответит сам. Экстренно — 112.',
  errPartnerMissing: 'Не указан партнёр',
  errPartnerInvalid: 'Некорректный партнёр',
  errSessionMissing: 'Не указан разговор',
  errSessionInvalid: 'Некорректный разговор',
  errMessageEmpty: 'Сообщение пустое',
  errMessageTooLong: (max) => `Сообщение длиннее ${max} знаков`,
  errHistoryItemTooLong: (max) => `Реплика в истории длиннее ${max} знаков`,
  errHistoryTooMany: (max) => `В истории больше ${max} реплик`,
  errHistoryTooLong: (max) => `История разговора длиннее ${max} знаков`,
  errInvalid: 'Некорректные данные',
  errServer: 'Ошибка обработки запроса',
};

const EN: WidgetTexts = {
  loading: 'Loading...',
  notFound: 'This partner’s chat was not found or is turned off.',
  loadFailed: 'The chat did not load — check your connection and reload the page. Emergency — 112.',
  sendFailed: 'Could not get a reply — please try again. Emergency — 112.',
  leadButton: 'Leave a request',
  assistantLabel: 'Vedar AI assistant',
  backToChat: 'Back to chat',
  leadFrameTitle: (name) => `Request to ${name}`,
  typing: 'Typing...',
  leadPrompt: 'Would you like the partner to pick a trip and call you?',
  inputPlaceholder: 'Type a message...',
  inputLabel: 'Message to the assistant',
  send: 'Send',
  emergency: 'Emergency — 112',
  poweredByBefore: 'Powered by ',
  brand: 'Vedar AI',
  poweredByAfter: '',
  defaultGreeting: (name) => `Hi! I am the AI assistant of ${name}. How can I help?`,
  promptLangName: 'английский',

  formTitleFallback: 'Tour request',
  formIntroDefault: 'Leave a request — you will be contacted at the phone number you give.',
  nameLabel: 'Your name *',
  namePlaceholder: 'John Smith',
  phoneLabel: 'Phone *',
  phonePlaceholder: '+44 20 0000 0000',
  commentLabel: 'What are you interested in? (optional)',
  commentPlaceholder: 'Route, dates, number of people...',
  consentRequired: 'Please give your consent to the processing of personal data',
  consentNote: 'The personal data consent above is in Russian, and the Russian text is the one that applies.',
  policyLink: 'Privacy policy (in Russian)',
  submitFailed: 'The request was not accepted. Please check your name and phone and try again.',
  networkFailed: 'Connection error. Please try again.',
  submit: 'Send request',
  submitting: 'Sending...',
  successTitle: 'Request received!',
  successText: 'A manager will contact you soon.',
  close: 'Close',

  chatFailed: 'The assistant could not answer right now — this is a failure on Vedar’s side. Please try again '
    + 'or leave a request with the “Leave a request” button — the partner will reply. Emergency — 112.',
  errPartnerMissing: 'Partner is not specified',
  errPartnerInvalid: 'Invalid partner',
  errSessionMissing: 'Conversation is not specified',
  errSessionInvalid: 'Invalid conversation',
  errMessageEmpty: 'The message is empty',
  errMessageTooLong: (max) => `The message is longer than ${max} characters`,
  errHistoryItemTooLong: (max) => `A message in the history is longer than ${max} characters`,
  errHistoryTooMany: (max) => `The history has more than ${max} messages`,
  errHistoryTooLong: (max) => `The conversation history is longer than ${max} characters`,
  errInvalid: 'Invalid request',
  errServer: 'The request could not be processed',
};

const ZH: WidgetTexts = {
  loading: '加载中...',
  notFound: '未找到该合作方的聊天，或聊天已关闭。',
  loadFailed: '聊天未能加载——请检查网络并刷新页面。紧急求助 — 112。',
  sendFailed: '未能获得回复——请重试。紧急求助 — 112。',
  leadButton: '留下申请',
  assistantLabel: 'Vedar AI 助手',
  backToChat: '返回聊天',
  leadFrameTitle: (name) => `向 ${name} 提交申请`,
  typing: '正在输入...',
  leadPrompt: '希望合作方为您挑选行程并给您回电吗？',
  inputPlaceholder: '请输入消息...',
  inputLabel: '发给助手的消息',
  send: '发送',
  emergency: '紧急求助 — 112',
  poweredByBefore: '由 ',
  brand: 'Vedar AI',
  poweredByAfter: ' 提供支持',
  defaultGreeting: (name) => `您好！我是 ${name} 的 AI 助手。有什么可以帮您？`,
  promptLangName: 'китайский',

  formTitleFallback: '旅游申请',
  formIntroDefault: '请留下申请——我们会通过您填写的电话与您联系。',
  nameLabel: '您的姓名 *',
  namePlaceholder: '张伟',
  phoneLabel: '电话 *',
  phonePlaceholder: '+86 138 0000 0000',
  commentLabel: '您对什么感兴趣？（选填）',
  commentPlaceholder: '路线、日期、人数……',
  consentRequired: '请同意处理个人数据',
  consentNote: '上方的个人数据处理同意书为俄文，以俄文原文为准。',
  policyLink: '隐私政策（俄文）',
  submitFailed: '申请未被接受，请检查姓名和电话后重试。',
  networkFailed: '连接错误，请重试。',
  submit: '提交申请',
  submitting: '正在发送...',
  successTitle: '申请已收到！',
  successText: '工作人员会尽快与您联系。',
  close: '关闭',

  chatFailed: '助手暂时无法回答——这是 Vedar 方面的故障。请重试，'
    + '或点击“留下申请”按钮留下申请——合作方会亲自回复。紧急求助 — 112。',
  errPartnerMissing: '未指定合作方',
  errPartnerInvalid: '合作方无效',
  errSessionMissing: '未指定会话',
  errSessionInvalid: '会话无效',
  errMessageEmpty: '消息为空',
  errMessageTooLong: (max) => `消息超过 ${max} 个字符`,
  errHistoryItemTooLong: (max) => `历史记录中有消息超过 ${max} 个字符`,
  errHistoryTooMany: (max) => `历史记录超过 ${max} 条消息`,
  errHistoryTooLong: (max) => `会话历史超过 ${max} 个字符`,
  errInvalid: '请求数据无效',
  errServer: '请求处理失败',
};

export const WIDGET_TEXTS: Readonly<Record<WidgetLang, WidgetTexts>> = { ru: RU, en: EN, zh: ZH };

export function widgetTexts(lang: WidgetLang): WidgetTexts {
  return WIDGET_TEXTS[lang];
}

/**
 * Приветствие окна: слова партнёра — как есть, на любом языке; наша заготовка
 * (партнёр приветствия не задал, роут подставил русскую) — на языке посетителя.
 */
export function widgetGreeting(lang: WidgetLang, greeting: string, partnerName: string): string {
  return greeting === RU.defaultGreeting(partnerName) ? WIDGET_TEXTS[lang].defaultGreeting(partnerName) : greeting;
}

/** Вступление формы: слова партнёра — как есть; наша заготовка — на языке посетителя. */
export function widgetFormIntro(lang: WidgetLang, formIntro: string | null | undefined): string {
  return formIntro && formIntro !== RU.formIntroDefault ? formIntro : WIDGET_TEXTS[lang].formIntroDefault;
}
