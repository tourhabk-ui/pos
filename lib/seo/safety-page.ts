/**
 * Текст, мета и разметка страницы /safety (Сыщик, 22.11).
 *
 * Прямой ответ на вопрос «безопасно ли ехать на Камчатку» — в серверном HTML,
 * без JavaScript. Утверждения только из официальных источников и из уже
 * опубликованных страниц vedarai.ru. Цен, оценочных слов и выдуманных
 * фактов в тексте нет.
 */

import type { FaqItem } from '@/lib/seo/faq';
import { DEFAULT_OG_IMAGE } from '@/lib/seo/og-image';
import { recordDateIso } from '@/lib/seo/record-modified';
import {
  MCHS_AFTER_RETURN,
  MCHS_DEADLINE_SHORT,
  MCHS_LEAD_WORKING_DAYS,
  MCHS_ONLINE_FORM_URL,
  MCHS_SOURCE,
} from '@/lib/safety/mchs-registration';
import {
  CUKS_CONSULT_PHONE,
  CUKS_DUTY_PHONE,
  CUKS_DUTY_RESERVE_PHONE,
  FEDERAL_EMERGENCY_NUMBERS,
  KRONOTSKY_RULES,
  MCHS_REGISTRATION_LEAD,
} from '@/lib/facts/kamchatka';

export const SAFETY_PAGE_DATE = '2026-11-22';

export const SAFETY_PAGE_TITLE = 'Безопасно ли ехать на Камчатку и как снизить риски';

export const SAFETY_PAGE_DESCRIPTION =
  'Ехать на Камчатку можно, если учитывать медведей, погоду, вулканы, воду и связь. Как снизить риски, зарегистрировать группу в МЧС и что делать в ЧП.';

export const SAFETY_PAGE_H1 = 'Безопасно ли ехать на Камчатку';

export const SAFETY_LEAD =
  'Ехать на Камчатку можно, если учитывать реальные риски — медведей, погоду, вулканы, воду и связь — и заранее снижать их: смотреть предупреждения, регистрировать маршрут в МЧС и знать, куда звонить в ЧП.';

export const SAFETY_AUTHOR = 'Редакция Vedar';

export const SAFETY_LIVE_HEADING = 'Какая обстановка на Камчатке сейчас?';

export const SAFETY_LIVE_LEAD =
  'Радар, предупреждения и коды вулканов обновляются автоматически. Алерты — на странице инцидентов.';

const MCHS_REG_URL =
  'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/registraciya-turisticheskih-grupp';
const MCHS_BEAR_URL =
  'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/bezopasnost-v-prirodnoy-srede/ostorozhno-buryy-medved-rekomendacii-lyubitelyam-prirody';
const MCHS_WARN_URL =
  'https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya';
const MCHS_112_NEWS_URL = 'https://41.mchs.gov.ru/deyatelnost/press-centr/novosti/5849794';
const KRONOKI_RULES_URL = KRONOTSKY_RULES.sourceUrl;
const KRONOKI_ORDER_URL = KRONOTSKY_RULES.orderUrl;
const KRONOKI_BEAR_URL = 'https://kronoki.ru/ru/visit/information-for-all/rules/430.html';
const KRONOKI_PREP_URL = 'https://kronoki.ru/ru/visit/information-for-all/preparing-for-travel/';
const KVERT_URL = 'http://kvert.febras.net/';
const KVERT_COLORS_URL = 'http://kvert.febras.net/color.php';
const VISIT_FAQ_URL = 'https://visitkamchatka.ru/faq/';
const COMMANDER_URL = 'https://commanderislands.ru/puteshestvennikam/';

const MCHS_CONSULT_PHONE = CUKS_CONSULT_PHONE.value;
const MCHS_DUTY_PHONE = CUKS_DUTY_PHONE.value;
const MCHS_DUTY_RESERVE = CUKS_DUTY_RESERVE_PHONE.value;
const [EMERGENCY_112, EMERGENCY_101, EMERGENCY_102, EMERGENCY_103] = FEDERAL_EMERGENCY_NUMBERS.value;

export const SAFETY_SECTIONS: readonly { id: string; heading: string; paragraphs: readonly string[] }[] = [
  {
    id: 'medvedi',
    heading: 'Опасны ли медведи на Камчатке?',
    paragraphs: [
      `Медведи на Камчатке встречаются и на маршрутах, и у населённых пунктов. Главное управление МЧС России по Камчатскому краю просит не приближаться к зверю, не бежать и не поворачиваться спиной, идти группой, держать детей рядом и не оставлять пищевые отходы. Если медведь уже заметил вас, охотоведы советуют шуметь и казаться больше; если зверь вышел в населённый пункт, звоните ${EMERGENCY_112}.`,
      `На территориях Кроноцкого заповедника, Корякского заповедника и Южно-Камчатского заказника смотреть на животных можно не ближе ${KRONOTSKY_RULES.animalDistanceM} метров, а дистанцию задаёт сопровождающий сотрудник учреждения. Подробнее — на странице о медведях Камчатки.`,
    ],
  },
  {
    id: 'vulkany',
    heading: 'Чем опасны вулканы и пепел?',
    paragraphs: [
      'На полуострове много действующих вулканов. Актуальную степень опасности для авиации и сведения о выбросах пепла публикует группа KVERT Института вулканологии и сейсмологии ДВО РАН: зелёный, жёлтый, оранжевый и красный коды. Перед поездкой сверьтесь с сообщениями KVERT и с живой сводкой выше на этой странице: извержение или пепловый шлейф могут изменить рейсы и маршруты. Обзор вулканов Камчатки — на отдельной странице.',
    ],
  },
  {
    id: 'pogoda',
    heading: 'Как следить за погодой и штормовыми предупреждениями?',
    paragraphs: [
      `Погода на Камчатке часто меняет планы. ГУ МЧС по краю публикует экстренные предупреждения — в том числе о шторме, метели, размыве песчаных кос и гидрологической обстановке. Консультацию по неблагоприятным явлениям на маршруте даёт ЦУКС по телефону ${MCHS_CONSULT_PHONE}. Климат по месяцам разобран на странице погоды, текущий прогноз — в блоке обстановки выше и в разделе «Погода».`,
    ],
  },
  {
    id: 'voda',
    heading: 'Чем опасна вода на Камчатке?',
    paragraphs: [
      'Маршруты по воде — сплавы и другие водные объекты с повышенным риском — МЧС края просит регистрировать так же, как горные и лесные. В экстренных предупреждениях ведомства бывают шторм, размыв песчаных кос и высокая вода: в такие дни к берегу и на водный маршрут не выходят, пока предупреждение действует.',
    ],
  },
  {
    id: 'mchs',
    heading: 'Нужно ли регистрировать группу в МЧС?',
    paragraphs: [
      `Да, если маршрут связан с активным туризмом и повышенным риском: горы, восхождения, сплавы, лес, труднодоступная местность. По приказу МЧС России от ${MCHS_REGISTRATION_LEAD.orderDateRu} ${MCHS_REGISTRATION_LEAD.order} уведомление подают за ${MCHS_LEAD_WORKING_DAYS} рабочих дней до начала маршрута — онлайн на сайте МЧС, заказным письмом в Петропавловск-Камчатский по улице Ленинградской, 25, или лично в ЦУКС по улице Тундровой, 6. ${MCHS_DEADLINE_SHORT}.`,
      `В маршрутном листе указывают состав группы, линию маршрута с координатами контрольных точек, средства связи и согласия участников на обработку персональных данных. ${MCHS_AFTER_RETURN} В МЧС Ведар не сообщает: подавали заявку — о возвращении туда сообщаете вы сами.`,
    ],
  },
  {
    id: 'svyaz',
    heading: 'Какая связь на маршруте?',
    paragraphs: [
      `В Петропавловске-Камчатском работает сеть 4G, но на удалённых территориях связь ограничена или отсутствует: например, национальный парк «Командорские острова» прямо предупреждает об этом. Голосовые вызовы, SMS и короткие номера ${EMERGENCY_112}, ${EMERGENCY_101}, ${EMERGENCY_102} и ${EMERGENCY_103} в известных случаях ограничений мобильного интернета продолжали работать. Вне зоны сотовой сети для вызова помощи нужен спутниковый коммуникатор. Как подготовиться — на странице о связи и интернете и в разделе «Связь на маршруте».`,
    ],
  },
  {
    id: 'samostoyatelno',
    heading: 'Можно ли ехать самостоятельно или нужен гид?',
    paragraphs: [
      'Самостоятельно можно передвигаться по дорогам центральной части полуострова, по городу и ближайшим маршрутам у Петропавловска-Камчатского. В Долину гейзеров и на Курильское озеро туристы попадают только в составе тура, как правило вертолётом. Самостоятельный маршрут по активному туризму нужно зарегистрировать в МЧС. На заповедных территориях Кроноцкого заповедника, Корякского заповедника и Южно-Камчатского заказника посетители находятся только в сопровождении сотрудников учреждения.',
    ],
  },
  {
    id: 'kronoki',
    heading: 'Какие правила в Кроноцком заповеднике?',
    paragraphs: [
      `С ${KRONOTSKY_RULES.orderDateLong} правила пребывания утверждены приказом № ${KRONOTSKY_RULES.order} ФГБУ «Кроноцкий государственный заповедник». Группы и одиночные посетители должны быть только с сотрудником учреждения, выполнять его требования и пройти инструктаж перед выходом. Дистанция до диких животных — не менее ${KRONOTSKY_RULES.animalDistanceM} метров. При непогоде, высокой вулканической или сейсмической активности либо опасном поведении животных сотрудник вправе изменить или сократить экскурсию. Полный текст правил — на сайте заповедника.`,
    ],
  },
  {
    id: 'chp',
    heading: 'Что делать в чрезвычайной ситуации?',
    paragraphs: [
      `Единый номер вызова экстренных служб — ${EMERGENCY_112}. Он работает по всей России, в том числе без баланса и SIM, и переключает на нужную службу. Пожарные и спасатели — ${EMERGENCY_101}, полиция — ${EMERGENCY_102}, скорая — ${EMERGENCY_103}. Проверенные телефоны дежурной смены ГУ МЧС по Камчатскому краю: ${MCHS_DUTY_PHONE} и резерв ${MCHS_DUTY_RESERVE}. Текущие предупреждения и закрытые маршруты — на странице инцидентов.`,
    ],
  },
];

export const SAFETY_FAQ_HEADING = 'Частые вопросы';

export const SAFETY_FAQ: readonly FaqItem[] = [
  {
    question: 'Безопасно ли сейчас ехать на Камчатку?',
    answer:
      'Смотрите текущие предупреждения на этой странице и экстренные предупреждения ГУ МЧС по Камчатскому краю. Общие риски — медведи, погода, вулканы, вода и связь — и способы их снизить разобраны выше.',
  },
  {
    question: 'За сколько дней регистрировать маршрут в МЧС?',
    answer: `За ${MCHS_LEAD_WORKING_DAYS} рабочих дней до начала маршрута, по приказу МЧС России от ${MCHS_REGISTRATION_LEAD.orderDateRu} ${MCHS_REGISTRATION_LEAD.order}. Форма — на сайте МЧС России.`,
  },
  {
    question: 'Можно ли самостоятельно попасть в Долину гейзеров?',
    answer:
      'Нет. На территориях Кроноцкого заповедника посетители находятся только в сопровождении сотрудника учреждения; в Долину гейзеров попадают в составе тура.',
  },
  {
    question: 'На каком расстоянии смотреть на медведей?',
    answer:
      `На территориях Кроноцкого заповедника и Южно-Камчатского заказника — не ближе ${KRONOTSKY_RULES.animalDistanceM} метров; дистанцию определяет сопровождающий сотрудник.`,
  },
  {
    question: 'Куда звонить, если нужна помощь?',
    answer: `На единый номер ${EMERGENCY_112}. Он переключит на пожарных и спасателей, полицию или скорую.`,
  },
  {
    question: 'Где смотреть активность вулканов?',
    answer: 'Актуальные коды опасности публикует KVERT. Живая сводка также стоит выше на этой странице.',
  },
];

export const SAFETY_RELATED_HEADING = 'Читайте также';

export const SAFETY_RELATED_INTRO =
  'Разбор отдельных рисков и подготовка к поездке — на тематических страницах Ведара.';

export const SAFETY_RELATED_LINKS = [
  { href: '/medvedi-kamchatki', label: 'Медведи Камчатки' },
  { href: '/vulkany-kamchatki-yunesko', label: 'Вулканы Камчатки' },
  { href: '/kamchatka-samostoyatelno', label: 'Камчатка самостоятельно' },
  { href: '/pogoda-na-kamchatke-po-mesyacam', label: 'Погода на Камчатке по месяцам' },
  { href: '/svyaz-i-internet-na-kamchatke', label: 'Связь и интернет на Камчатке' },
  { href: '/safety/incidents', label: 'Инциденты и предупреждения' },
] as const;

export const SAFETY_SOURCES_HEADING = 'Источники';

export const SAFETY_SOURCES: readonly { label: string; href: string }[] = [
  { label: 'ГУ МЧС России по Камчатскому краю, регистрация туристических групп', href: MCHS_REG_URL },
  { label: `${MCHS_SOURCE.authority}, ${MCHS_SOURCE.asOf}`, href: MCHS_SOURCE.memoUrl },
  { label: 'ГУ МЧС России по Камчатскому краю, «Осторожно, бурый медведь!»', href: MCHS_BEAR_URL },
  { label: 'ГУ МЧС России по Камчатскому краю, экстренные предупреждения', href: MCHS_WARN_URL },
  { label: 'ГУ МЧС России по Камчатскому краю, регистрация групп в 2026 году (номер 112)', href: MCHS_112_NEWS_URL },
  { label: 'Форма уведомления о туристском маршруте, МЧС России', href: MCHS_ONLINE_FORM_URL },
  { label: `Кроноцкий заповедник, общие правила пребывания (приказ № ${KRONOTSKY_RULES.order} от ${KRONOTSKY_RULES.orderDateShort})`, href: KRONOKI_RULES_URL },
  { label: `Кроноцкий заповедник, приказ № ${KRONOTSKY_RULES.order} от ${KRONOTSKY_RULES.orderDateShort} и правила 2026 года`, href: KRONOKI_ORDER_URL },
  { label: 'Кроноцкий заповедник, безопасное наблюдение за медведем', href: KRONOKI_BEAR_URL },
  { label: 'Кроноцкий заповедник, подготовка к путешествию', href: KRONOKI_PREP_URL },
  { label: 'KVERT, Институт вулканологии и сейсмологии ДВО РАН', href: KVERT_URL },
  { label: 'KVERT, авиационные цветовые коды', href: KVERT_COLORS_URL },
  { label: 'Visit Kamchatka, часто задаваемые вопросы (связь 4G)', href: VISIT_FAQ_URL },
  { label: 'Национальный парк «Командорские острова», путешественникам', href: COMMANDER_URL },
  { label: 'Ведар, медведи Камчатки', href: 'https://vedarai.ru/medvedi-kamchatki' },
  { label: 'Ведар, Камчатка самостоятельно', href: 'https://vedarai.ru/kamchatka-samostoyatelno' },
  { label: 'Ведар, связь и интернет на Камчатке', href: 'https://vedarai.ru/svyaz-i-internet-na-kamchatke' },
  { label: 'Ведар, погода на Камчатке по месяцам', href: 'https://vedarai.ru/pogoda-na-kamchatke-po-mesyacam' },
  { label: 'Ведар, вулканы Камчатки', href: 'https://vedarai.ru/vulkany-kamchatki-yunesko' },
];

/** Фрагменты, которые в тексте становятся ссылками. Более длинные — раньше. */
export const SAFETY_TEXT_LINKS = [
  { text: 'странице о медведях Камчатки', href: '/medvedi-kamchatki', external: false },
  { text: 'Обзор вулканов Камчатки', href: '/vulkany-kamchatki-yunesko', external: false },
  { text: 'странице погоды', href: '/pogoda-na-kamchatke-po-mesyacam', external: false },
  { text: 'разделе «Погода»', href: '/weather', external: false },
  { text: 'странице о связи и интернете', href: '/svyaz-i-internet-na-kamchatke', external: false },
  { text: 'разделе «Связь на маршруте»', href: '/safety/communication', external: false },
  { text: 'странице инцидентов', href: '/safety/incidents', external: false },
  { text: 'сайте заповедника', href: KRONOKI_RULES_URL, external: true },
  { text: 'сообщениями KVERT', href: KVERT_URL, external: true },
  { text: 'публикует KVERT', href: KVERT_URL, external: true },
  { text: 'онлайн на сайте МЧС', href: MCHS_ONLINE_FORM_URL, external: true },
  { text: 'на сайте МЧС России', href: MCHS_ONLINE_FORM_URL, external: true },
  { text: 'экстренные предупреждения ГУ МЧС по Камчатскому краю', href: MCHS_WARN_URL, external: true },
] as const;

export const SAFETY_INCIDENTS_LEAD =
  'Текущие предупреждения, закрытые маршруты и экстренные контакты Камчатки собраны на этой странице. Общий ответ, безопасно ли ехать, и как снизить риски — в разборе';

export const SAFETY_INCIDENTS_PREP_HEADING = 'Что сделать перед выходом на маршрут?';

const SITE = 'https://vedarai.ru';

export function safetyArticleJsonLd(site: string = SITE): Record<string, unknown> {
  const url = `${site}/safety`;
  const published = recordDateIso(SAFETY_PAGE_DATE);
  const org = { '@type': 'Organization', '@id': `${site}/#organization`, name: 'Ведар Камчатка', url: site };
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: SAFETY_PAGE_H1,
    description: SAFETY_PAGE_DESCRIPTION,
    inLanguage: 'ru',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    image: `${site}${DEFAULT_OG_IMAGE}`,
    author: { '@type': 'Organization', name: SAFETY_AUTHOR, url: site },
    publisher: org,
    datePublished: published,
    dateModified: published,
  };
}

export function safetyVisibleText(): string {
  const parts = [
    SAFETY_PAGE_H1,
    SAFETY_LEAD,
    SAFETY_LIVE_HEADING,
    SAFETY_LIVE_LEAD,
    SAFETY_AUTHOR,
    ...SAFETY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]),
    SAFETY_FAQ_HEADING,
    ...SAFETY_FAQ.flatMap((f) => [f.question, f.answer]),
    SAFETY_RELATED_HEADING,
    SAFETY_RELATED_INTRO,
    ...SAFETY_RELATED_LINKS.map((l) => l.label),
    SAFETY_SOURCES_HEADING,
    ...SAFETY_SOURCES.map((s) => s.label),
  ];
  return parts.join(' ');
}

export function safetyWordCount(text: string = safetyVisibleText()): number {
  return text.split(/\s+/).filter((w) => /[A-Za-zА-Яа-я0-9]/.test(w)).length;
}
