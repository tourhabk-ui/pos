/**
 * Посадочные страницы под поисковые запросы туристов (проверка видимости
 * 17.10: Ведара нет в выдаче ни по одному из 9 запросов, zh — ktullc.ru).
 *
 * Здесь только то, что не зависит от базы: адреса, языки, заголовки, общий
 * текст и FAQ о том, как устроена заявка (тот же смысл, что ZH_PAGE.booking:
 * заявку подтверждает человек, онлайн-оплаты нет, оплата — оператору). Туры,
 * цены «от», даты и операторы страница читает из базы на запросе
 * (lib/seo/query-landings-data). Цифр и фактов о турах в этом файле нет.
 *
 * hreflang — только внутри группы `pair` и только между страницами, которые
 * есть в этом списке: каждая ссылается на остальных членов группы, значит
 * пара взаимна по построению. Сторож: tests/unit/query-landings.test.ts.
 */

export type LandingLang = 'ru' | 'en' | 'zh-CN';
/** Какие туры показывает страница: все на витрине или одна тема. */
export type LandingTopic = 'all' | 'bears' | 'volcano';

export interface LandingFaq { q: string; a: string }

export interface QueryLanding {
  key: string;
  path: string;
  lang: LandingLang;
  topic: LandingTopic;
  /** Поисковый запрос, под который страница сделана (для сторожа и отчёта). */
  query: string;
  /** Группа языковых двойников; страницы без группы hreflang не получают. */
  pair: string | null;
  title: string;
  description: string;
  h1: string;
  intro: string;
  faq: LandingFaq[];
}

const ZH_BOOKING_FAQ: LandingFaq[] = [
  { q: '如何通过 Vedar 预订堪察加团队游？', a: '在本页选择团队游，打开俄文原页，填写预订申请（日期、人数、联系方式）。申请发送给旅行社，由人工确认。' },
  { q: '可以在线付款吗？', a: '不可以。Vedar 不收取在线付款，款项在确认后直接付给旅行社。' },
  { q: '本页价格是最终价格吗？', a: '本页价格为旅行社在平台上填写的“起价”，最终价格以旅行社确认为准。' },
  { q: 'AI 助手能直接查询这些团队游吗？', a: '可以。Vedar 提供 MCP 服务器 https://vedarai.ru/api/mcp（无需认证），AI 助手可查询团队游、天气和提交申请。' },
];

const RU_BOOKING_FAQ: LandingFaq[] = [
  { q: 'Как забронировать тур на Камчатку через Ведар?', a: 'Выберите тур на этой странице, откройте его карточку и оставьте заявку: дата, число людей, контакт. Заявка уходит туроператору, подтверждает её человек.' },
  { q: 'Нужно ли платить онлайн?', a: 'Нет. Онлайн-оплаты на Ведаре нет: оплата — напрямую туроператору после подтверждения.' },
  { q: 'Есть ли туры на 2027 год?', a: 'Даты публикуют сами операторы. Если у тура уже открыта дата, она указана в списке; у остальных даты — по запросу, сезон тура указан по данным оператора.' },
  { q: 'Цена на странице окончательная?', a: 'Это цена «от», которую оператор указал на платформе. Итог называет оператор при подтверждении.' },
  { q: 'Можно ли спросить про туры через ИИ-ассистента?', a: 'Да. У Ведара открытый MCP-сервер https://vedarai.ru/api/mcp без авторизации: его подключают в Claude, ChatGPT и других клиентах, инструкция — на странице /mcp.' },
];

const EN_BOOKING_FAQ: LandingFaq[] = [
  { q: 'How do I book a Kamchatka tour on Vedar?', a: 'Pick a tour on this page, open its card and send a booking request with date, group size and contact. The request goes to the tour operator and is confirmed by a person.' },
  { q: 'Do I pay online?', a: 'No. Vedar takes no online payment; you pay the operator directly after confirmation.' },
  { q: 'Are the prices final?', a: 'Prices are the "from" prices operators entered on the platform. The final price is confirmed by the operator.' },
  { q: 'Can an AI assistant query these tours?', a: 'Yes. Vedar runs an open MCP server at https://vedarai.ru/api/mcp (no auth) that Claude, ChatGPT and other clients can connect to; see /mcp.' },
];

export const QUERY_LANDINGS: readonly QueryLanding[] = [
  {
    key: 'zh-booking', path: '/zh/booking', lang: 'zh-CN', topic: 'all', query: '堪察加 旅游 预订', pair: 'booking',
    title: '堪察加旅游预订：当地运营商团队游与起价｜Vedar 堪察加',
    description: 'Vedar 堪察加是堪察加旅游信息门户：当地运营商的团队游、起价、开放日期。申请由人确认，无在线支付，款项付给运营商。',
    h1: '堪察加旅游预订',
    intro: '以下团队游来自 Vedar 堪察加数据库中已发布的当地运营商产品，价格为运营商填写的起价，日期为运营商开放的日期。',
    faq: ZH_BOOKING_FAQ,
  },
  {
    key: 'zh-volcano', path: '/zh/volcano-tours', lang: 'zh-CN', topic: 'volcano', query: '堪察加 火山 旅游', pair: null,
    title: '堪察加火山旅游：火山团队游、起价与申请｜Vedar 堪察加',
    description: '堪察加火山团队游：Vedar 堪察加门户中当地运营商的火山线路、起价、季节与开放日期。申请由人确认，门户不是旅行社。',
    h1: '堪察加火山旅游',
    intro: '列表为 Vedar 堪察加数据库中名称、简介或类型涉及火山的已发布团队游；季节与价格均为运营商填写的数据。',
    faq: ZH_BOOKING_FAQ,
  },
  {
    key: 'ru-booking', path: '/bronirovanie-turov-kamchatka', lang: 'ru', topic: 'all', query: 'где забронировать тур на Камчатку · туры на Камчатку 2027', pair: 'booking',
    title: 'Где забронировать тур на Камчатку: туры 2027, цены от, даты',
    description: 'Как забронировать тур на Камчатку у местных операторов через Ведар: живые туры, цены «от», открытые даты 2027. Подтверждает человек, оплата оператору.',
    h1: 'Где забронировать тур на Камчатку',
    intro: 'Ниже — туры, которые операторы сейчас публикуют на Ведаре: цена «от» и даты — из их данных. Заявка уходит оператору напрямую.',
    faq: RU_BOOKING_FAQ,
  },
  {
    key: 'ru-bears', path: '/tury-medvedi-kamchatka', lang: 'ru', topic: 'bears', query: 'Камчатка медведи тур', pair: 'bears',
    title: 'Туры к медведям на Камчатке: наблюдение, цены от, даты',
    description: 'Туры на Камчатке с наблюдением медведей от местных операторов: цены «от», сезон и открытые даты из базы Ведара, заявка оператору.',
    h1: 'Туры к медведям на Камчатке',
    intro: 'В списке — опубликованные туры, у которых вид «наблюдение за медведями» или медведи названы в названии и описании.',
    faq: RU_BOOKING_FAQ.filter((f) => !f.q.includes('2027')),
  },
  {
    key: 'en-booking', path: '/en/kamchatka-tours', lang: 'en', topic: 'all', query: 'Kamchatka tours booking', pair: 'booking',
    title: 'Kamchatka Tours Booking: Local Operators, Prices From, Dates | Vedar',
    description: 'Book Kamchatka tours from local operators on Vedar: live tours, "from" prices, open dates. Confirmed by a person, no online payment.',
    h1: 'Kamchatka tours booking',
    intro: 'Tours below are currently published on Vedar by local operators. Prices and dates come from their data; tour names are shown as the operator wrote them (in Russian).',
    faq: EN_BOOKING_FAQ,
  },
  {
    key: 'en-bears', path: '/en/bear-watching', lang: 'en', topic: 'bears', query: 'Kamchatka bear watching tour', pair: 'bears',
    title: 'Kamchatka Bear Watching Tours: Prices From, Season, Dates | Vedar',
    description: 'Kamchatka bear watching tours from local operators: "from" prices, season and open dates from the Vedar database. Send a request to the operator.',
    h1: 'Kamchatka bear watching tours',
    intro: 'Listed are published tours whose type is bear watching or whose name or summary mentions bears. Names are shown as the operator wrote them (in Russian).',
    faq: EN_BOOKING_FAQ,
  },
];

export function landingByKey(key: string): QueryLanding {
  const l = QUERY_LANDINGS.find((x) => x.key === key);
  if (!l) throw new Error(`query-landings: нет страницы «${key}»`);
  return l;
}

/** Двойники страницы по группе — для hreflang; без группы — пусто. */
export function landingAlternates(l: QueryLanding, site: string): Record<string, string> {
  if (!l.pair) return {};
  const group = QUERY_LANDINGS.filter((x) => x.pair === l.pair);
  if (group.length < 2) return {};
  const out: Record<string, string> = {};
  for (const x of group) out[x.lang] = `${site}${x.path}`;
  const ru = group.find((x) => x.lang === 'ru');
  if (ru) out['x-default'] = `${site}${ru.path}`;
  return out;
}

/** Страницы одного языка, кроме данной, — перелинковка внутри языка. */
export function siblingLandings(l: QueryLanding): QueryLanding[] {
  return QUERY_LANDINGS.filter((x) => x.lang === l.lang && x.key !== l.key);
}

export const LANDING_OG_LOCALE: Record<LandingLang, string> = { ru: 'ru_RU', en: 'en_US', 'zh-CN': 'zh_CN' };
