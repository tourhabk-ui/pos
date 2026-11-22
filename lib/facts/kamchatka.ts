/**
 * Единый справочник фактов о Камчатке для страниц и llms.txt.
 *
 * Сюда попадает только то, что уже опубликовано на сайте и имеет источник.
 * У каждого факта — значение, URL источника и дата сверки. Цифры на
 * /safety, /fish, /prepare и в llms.txt читаются отсюда, чтобы не разойтись.
 * Цен и выдуманных сведений нет. Имена мест не меняются.
 *
 * Тексты посадочных собраны скриптом из markdown — высоты там не
 * интерполируются; совпадение с этим справочником держит тест.
 */

export type SourcedFact<T> = {
  value: T;
  /** URL первоисточника, уже указанный на сайте. Нет публичного URL — null. */
  sourceUrl: string | null;
  /** День сверки с источником (ISO). */
  checkedAt: string;
  sourceLabel: string;
};

/** Каталог KVERT, Институт вулканологии и сейсмологии ДВО РАН. */
export const KVERT_CATALOG_URL = 'http://kvert.febras.net/';

export const AVACHINSKY_HEIGHT_M: SourcedFact<2751> = {
  value: 2751,
  sourceUrl: 'http://kvert.febras.net/volc?lang=ru&name=Avachinsky',
  checkedAt: '2026-11-21',
  sourceLabel: 'KVERT, ИВиС ДВО РАН, «Активные вулканы Камчатки и Курил. Авачинский»',
};

export const MUTNOVSKY_HEIGHT_M: SourcedFact<2323> = {
  value: 2323,
  sourceUrl: 'http://kvert.febras.net/volc?lang=ru&name=Mutnovsky',
  checkedAt: '2026-11-21',
  sourceLabel: 'KVERT, ИВиС ДВО РАН, «Мутновский»',
};

/** Срок подачи уведомления о туристском маршруте. */
export const MCHS_REGISTRATION_LEAD = {
  value: 10,
  unit: 'working_days' as const,
  order: '№ 270',
  orderDateIso: '2023-03-29',
  /** Как в тексте /safety: «от 29 марта 2023 года». */
  orderDateRu: '29 марта 2023 года',
  sourceUrl:
    'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/registraciya-turisticheskih-grupp',
  memoUrl:
    'https://41.mchs.gov.ru/uploads/resource/2024-06-13/registraciya-turisticheskih-grupp_1718249913116706118.pdf',
  formUrl: 'https://forms.mchs.gov.ru/registration_tourist_groups/form',
  checkedAt: '2026-11-22',
  sourceLabel:
    'Приказ МЧС России от 29 марта 2023 года № 270; страница ГУ МЧС по Камчатскому краю о регистрации групп',
} as const;

/** Правила Кроноцкого заповедника (приказ № 24-П). */
export const KRONOTSKY_RULES = {
  order: '24-П',
  orderDateIso: '2026-01-29',
  orderDateShort: '29.01.2026',
  orderDateLong: '29 января 2026 года',
  animalDistanceM: 20,
  sourceUrl: 'https://kronoki.ru/ru/visit/information-for-all/rules/447.html',
  orderUrl: 'https://kronoki.ru/ru/about/documents/3536.html',
  checkedAt: '2026-11-22',
  sourceLabel: 'Кроноцкий заповедник, общие правила пребывания (приказ № 24-П от 29.01.2026)',
} as const;

const MCHS_112_NEWS_URL = 'https://41.mchs.gov.ru/deyatelnost/press-centr/novosti/5849794';

/** Федеральные короткие номера, как на /safety. */
export const FEDERAL_EMERGENCY_NUMBERS = {
  value: ['112', '101', '102', '103'] as const,
  sourceUrl: MCHS_112_NEWS_URL,
  checkedAt: '2026-11-22',
  sourceLabel: 'ГУ МЧС России по Камчатскому краю, регистрация групп в 2026 году (номер 112)',
} as const;

/**
 * Телефоны ЦУКС и дежурной смены, которые названы на /safety.
 * 30-10-81 сверен по странице ГУ МЧС о регистрации групп (22.10.2026).
 * 30-10-89 и 20-01-12 — сверка владельца 17.07.2026; отдельного URL ведомства
 * в источниках страницы нет, выдумывать ссылку нельзя.
 */
export const CUKS_CONSULT_PHONE: SourcedFact<'+7 (4152) 30-10-81'> = {
  value: '+7 (4152) 30-10-81',
  sourceUrl:
    'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/registraciya-turisticheskih-grupp',
  checkedAt: '2026-10-22',
  sourceLabel:
    'ЦУКС ГУ МЧС Камчатки — консультации по маршрутному листу и предупреждениям на маршруте',
};

export const CUKS_DUTY_PHONE: SourcedFact<'+7 (4152) 30-10-89'> = {
  value: '+7 (4152) 30-10-89',
  sourceUrl: null,
  checkedAt: '2026-07-17',
  sourceLabel: 'МЧС Камчатки — оперативный дежурный (СОД); сверка владельца 17.07.2026',
};

export const CUKS_DUTY_RESERVE_PHONE: SourcedFact<'+7 (4152) 20-01-12'> = {
  value: '+7 (4152) 20-01-12',
  sourceUrl: null,
  checkedAt: '2026-07-17',
  sourceLabel: 'МЧС Камчатки — оперативный дежурный, резерв (СОД); сверка владельца 17.07.2026',
};

const VISIT_FISH_URL = 'https://visitkamchatka.ru/activities/rybalka/';
const KAM24_SEASON_URL = 'https://kam24.ru/news/main/20260514/128189.html';
const RYBAK_CLOSE_URL =
  'https://rybak-kamchatky.ru/news/5472-v-seti-mozhno-poluchit-informaciyu-o-mestah-prodazhi-putevok-na-lyubitelskii-lov.html';

/** Окно хода лососей по Visit Kamchatka, как на /fish. */
export const FISH_SALMON_RUN_WINDOW: SourcedFact<string> = {
  value:
    'с середины мая до начала декабря в реки заходят все шесть видов лосося, а «мёртвого» сезона на полуострове нет',
  sourceUrl: VISIT_FISH_URL,
  checkedAt: '2026-11-22',
  sourceLabel: 'Visit Kamchatka, «Рыбалка»',
};

export const SALMON_FISH_IDS: ReadonlySet<string> = new Set([
  'chavycha',
  'nerka',
  'kizuch',
  'gorbuscha',
  'keta',
  'losos',
]);

/** Официальные сроки любительского лова лососей в 2026 году (как на /fish). */
export const SALMON_OFFICIAL_SEASON = {
  year: 2026,
  text:
    'Официальные сроки любительского лова лососей в 2026 году: с 1 июня в реках и озёрах края, ' +
    'на реках Паратунка и Авача — только с 5 июля; 31 октября лов закрыли. Сроки хода рыбы в справочнике — ориентир: ' +
    'ловить можно в официальные сроки и по путёвке. Сроки на 2027 год ещё не утверждены.',
  sources: [
    {
      title: 'Кам 24, «Власти Камчатки утвердили даты открытия лососевой путины – 2026» (14.05.2026)',
      url: KAM24_SEASON_URL,
    },
    {
      title: '«Рыбак Камчатки», «На Камчатке окончательно закрылся лов лососей» (02.11.2026)',
      url: RYBAK_CLOSE_URL,
    },
  ],
  sourceUrl: KAM24_SEASON_URL,
  checkedAt: '2026-11-21',
  sourceLabel: 'ИА «Кам 24» (14.05.2026) и «Рыбак Камчатки» (02.11.2026)',
} as const;

/**
 * Сроки хода, как они написаны на /fish (не карточки видов: формулировки там
 * чуть другие). Источник — тот, что уже стоит у вида или у абзаца страницы.
 */
/**
 * Сроки хода на /fish даны как ориентир справочника Ведара. Внешние URL
 * у этих дат на странице не стоят — не приписываем чужим материалам
 * камчатский график. Источник — опубликованный справочник /fish.
 */
export const FISH_SEASONS = {
  chavycha: {
    value: 'с 1 июня по 15 июля',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  nerka: {
    value: 'в июле и августе',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  gorbuscha: {
    value: 'в июле и августе',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  keta: {
    value: 'с июля по октябрь',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  kizuch: {
    value: 'с августа по октябрь',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  mikizha_golets: {
    value: 'круглый год',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  kharius: {
    value: 'с июня по сентябрь',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  kundzha: {
    value: 'с июля по сентябрь',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  paltus: {
    value: 'с июня по сентябрь',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  treska: {
    value: 'круглый год с пиком зимой',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
  navaga: {
    value: 'с ноября по март',
    sourceUrl: 'https://vedarai.ru/fish',
    checkedAt: '2026-11-22',
    sourceLabel: 'Справочник Ведара /fish',
  },
} as const satisfies Record<string, SourcedFact<string>>;

/** Посадочные, где уже стоят высоты из этого справочника (тексты собраны скриптом). */
export const LANDINGS_WITH_VOLCANO_HEIGHTS = [
  'voshozhdenie-na-avachinskij-vulkan',
  'avachinskij-pereval-i-verblyud',
  'voshozhdeniya-na-vulkany-kamchatki',
  'vulkan-mutnovskij-zakryt',
  'voshozhdenie-na-vulkan-gorelyj',
] as const;
