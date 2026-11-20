/**
 * Посадочные страницы Сыщика (20.11.2026): 17 новых адресов и 4 апгрейда;
 * вторая партия (21.11.2026, lib/landings/texts-batch2.ts) — ещё 10 новых;
 * третья (21.11.2026, lib/landings/texts-batch3.ts) — 9 новых и 3 апгрейда
 * (/places/kurilskoe-ozero, /places/vulkan-mutnovskij,
 * /voshozhdenie-na-avachinskij-vulkan).
 *
 * существующих (/plans/kamchatka-v-iyune, /plans/kamchatka-v-sentyabre,
 * /dolina-gejzerov-ekskursiya, /places/paratunskaya-zona-otdyha).
 *
 * Текст — lib/landings/texts.ts (собран из markdown). Здесь — то, что не текст:
 * какие туры из базы показывает блок страницы, перелинковка месяцев и защита
 * от каннибализации. Туров, цен и дат в этом файле нет: их читает
 * lib/landings/tours.ts на запросе.
 */
import type { LandingTopic } from '@/lib/seo/query-landings';
import { LANDING_TEXTS, type LandingText } from '@/lib/landings/texts';
import { LANDING_TEXTS_BATCH2 } from '@/lib/landings/texts-batch2';
import { LANDING_TEXTS_BATCH3 } from '@/lib/landings/texts-batch3';

/** Какие туры показывает блок страницы. */
export type LandingTourSpec =
  /** Туры, у которых выезд возможен в этом месяце (1–12): сезон или открытая дата. */
  | { kind: 'month'; month: number }
  /** Тема посадочных lib/seo/query-landings (тот же отбор, что у /tury-*). */
  | { kind: 'topic'; topic: LandingTopic }
  /** Слово в названии или месте назначения тура. */
  | { kind: 'text'; pattern: RegExp }
  /** Лёгкие туры до суток: сложность «easy» и длительность из карточки тура. */
  | { kind: 'easy' }
  /** Все туры витрины (порядок — правило 1в). */
  | { kind: 'all' }
  /** Блока туров у страницы нет: в тексте его не было. */
  | { kind: 'none' };

export const MONTH_SLUGS = [
  'kamchatka-v-yanvare', 'kamchatka-v-fevrale', 'kamchatka-v-marte', 'kamchatka-v-aprele',
  'kamchatka-v-mae', 'kamchatka-v-iyune', 'kamchatka-v-iyule', 'kamchatka-v-avguste',
  'kamchatka-v-sentyabre', 'kamchatka-v-oktyabre', 'kamchatka-v-noyabre', 'kamchatka-v-dekabre',
] as const;

export const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Хаб месячных страниц. */
export const MONTHS_HUB = { href: '/kogda-ehat-na-kamchatku', label: 'Когда ехать на Камчатку' };

const TOUR_SPECS: Record<string, LandingTourSpec> = {
  ...Object.fromEntries(MONTH_SLUGS.map((s, i) => [s, { kind: 'month', month: i + 1 } as LandingTourSpec])),
  'medvedi-kamchatki': { kind: 'topic', topic: 'bears' },
  'dolina-gejzerov-kak-popast': { kind: 'topic', topic: 'geysers' },
  'paratunka': { kind: 'text', pattern: /паратунк/i },
  'morskie-progulki-kamchatka': { kind: 'text', pattern: /(^|[^а-яё])(морск[а-яё]*\s+прогулк|катер|бухт[а-яё]*\s+русск|три\s+брата|старичков|кит(ы|ов|ам)?(?![а-яё])|косатк)/i },
  // Признака «семейный» у тура в базе нет: блок — лёгкие туры до суток по полям
  // difficulty и duration_hours, и подпись так и говорит.
  'kamchatka-s-detmi': { kind: 'easy' },
  'chto-posmotret-na-kamchatke': { kind: 'all' },
  'petropavlovsk-za-den': { kind: 'text', pattern: /(петропавловск|морск[а-яё]*\s+прогулк|три\s+брата|авачинск[а-яё]*\s+(бух|губ)|халактыр)/i },
  'kak-dobratsya-na-kamchatku': { kind: 'none' },
  'kamchatka-samostoyatelno': { kind: 'none' },
  // Вторая партия (21.11): отбор по словам в названии и месте тура.
  'chto-privezti-s-kamchatki': { kind: 'text', pattern: /(гастроном|рыбалк|рыболов|икр)/i },
  'kamchatskaya-kukhnya-gde-poest': { kind: 'text', pattern: /(гастроном|кухн|рыбалк|рыболов)/i },
  'gornolyzhnye-bazy-kamchatki': { kind: 'text', pattern: /(горнолыж|лыж|сноуборд|фрирайд|зимн)/i },
  'heli-ski-kamchatka': { kind: 'text', pattern: /(хели|heli)/i },
  'novyj-god-na-kamchatke': { kind: 'text', pattern: /(новогод|нов(ый|ого|ом)\s+год)/i },
  'putevka-na-rybalku-gosuslugi41': { kind: 'topic', topic: 'fishing' },
  'propusk-ustoj-m-vilyuchinskij-pereval': { kind: 'text', pattern: /вилючинск/i },
  'tolbachik-samostoyatelno': { kind: 'topic', topic: 'tolbachik' },
  'nepogoda-otmenili-vertolet': { kind: 'topic', topic: 'helicopter' },
  'stoit-li-ekhat-na-kamchatku': { kind: 'all' },
  // Третья партия (21.11).
  'skolko-dnej-nuzhno-na-kamchatku': { kind: 'text', pattern: /(курильск|командор)/i },
  'pogoda-na-kamchatke-po-mesyacam': { kind: 'all' },
  'chto-vzyat-s-soboj-na-kamchatku': { kind: 'all' },
  'svyaz-i-internet-na-kamchatke': { kind: 'none' },
  'komandorskie-ostrova-kak-popast': { kind: 'text', pattern: /командор/i },
  'kurilskoe-ozero-kak-dobratsya': { kind: 'topic', topic: 'kurile' },
  'mozhno-li-kupatsya-na-kamchatke': { kind: 'text', pattern: /(термал|паратунк|купан)/i },
  'splav-na-kamchatke': { kind: 'text', pattern: /сплав/i },
  'voshozhdenie-na-avachinskij-vulkan': { kind: 'topic', topic: 'avacha' },
  // Маршрут на Мутновский закрыт (lib/routes/closures): блок — облёты и туры
  // к Горелому и Дачным источникам, как и написано в тексте.
  'vulkan-mutnovskij-zakryt': { kind: 'text', pattern: /(горел|дачн|облёт|облет)/i },
  'vulkany-kamchatki-yunesko': { kind: 'topic', topic: 'volcano' },
  'raznica-vo-vremeni-kamchatka-moskva': { kind: 'none' },
};

export interface Landing extends LandingText {
  tours: LandingTourSpec;
}

export const LANDINGS: readonly Landing[] = [...LANDING_TEXTS, ...LANDING_TEXTS_BATCH2, ...LANDING_TEXTS_BATCH3].map((t) => ({ ...t, tours: TOUR_SPECS[t.slug] ?? { kind: 'none' } }));

export function landingBySlug(slug: string): Landing {
  const l = LANDINGS.find((x) => x.slug === slug);
  if (!l) throw new Error(`нет посадочной ${slug}`);
  return l;
}

export function landingByPath(path: string): Landing | null {
  return LANDINGS.find((x) => x.path === path) ?? null;
}

/** Новые адреса (их страницы — app/<slug>/page.tsx и sitemap). */
export const NEW_LANDINGS: readonly Landing[] = LANDINGS.filter((l) => l.type === 'new');

/** Месяцы по порядку: адрес и подпись — для перелинковки и хаба. */
export function monthLinks(): Array<{ month: number; href: string; label: string }> {
  return MONTH_SLUGS.map((s, i) => ({ month: i + 1, href: landingBySlug(s).path, label: MONTH_NAMES[i] }));
}

export function isMonthLanding(l: Landing): boolean {
  return (MONTH_SLUGS as readonly string[]).includes(l.slug);
}

/**
 * Каннибализация (Сыщик, 20.11): старые страницы ведут на посадочную.
 * `canonical` — адрес, который страница объявляет каноническим вместо себя;
 * `link` — видимая ссылка «Подробнее» на посадочную.
 */
export const LANDING_CANONICAL: Readonly<Record<string, string>> = {
  '/routes/medvedi-kamchatki': '/medvedi-kamchatki',
};

export const LANDING_CROSS_LINKS: Readonly<Record<string, { href: string; label: string }>> = {
  '/routes/medvedi-kamchatki': { href: '/medvedi-kamchatki', label: 'Где посмотреть медведей на Камчатке' },
  '/places/dolina-gejzerov': { href: '/dolina-gejzerov-ekskursiya', label: 'Как попасть в Долину гейзеров: экскурсии и туры' },
  '/articles/dolina-gejzerov': { href: '/dolina-gejzerov-ekskursiya', label: 'Как попасть в Долину гейзеров: экскурсии и туры' },
  '/routes/paratunka': { href: '/places/paratunskaya-zona-otdyha', label: 'Паратунка: термальные источники, бассейны, как добраться' },
  // Вторая партия (21.11).
  '/articles/zima': { href: '/novyj-god-na-kamchatke', label: 'Новый год на Камчатке 2026/27: туры, даты и праздники' },
  '/hub/fishing': { href: '/putevka-na-rybalku-gosuslugi41', label: 'Путёвка на рыбалку через Госуслуги41: как оформить и закрыть' },
  '/places/vilyuchinskij-pereval': { href: '/propusk-ustoj-m-vilyuchinskij-pereval', label: 'Пропуск «Устой-М» на Вилючинский перевал: официальный порядок' },
  '/routes/vilyuchinskij-pereval-marshrut': { href: '/propusk-ustoj-m-vilyuchinskij-pereval', label: 'Пропуск «Устой-М» на Вилючинский перевал: официальный порядок' },
  '/park/vilyuchinsky': { href: '/propusk-ustoj-m-vilyuchinskij-pereval', label: 'Пропуск «Устой-М» на Вилючинский перевал: официальный порядок' },
  // Третья партия (21.11).
  '/park/komandorskiy': { href: '/komandorskie-ostrova-kak-popast', label: 'Командорские острова: как попасть и какие нужны разрешения' },
  '/routes/splav-po-reke-bystraya': { href: '/splav-na-kamchatke', label: 'Сплав на Камчатке: реки, сезон, рафтинг по Быстрой' },
  '/articles/vulkany-kamchatki': { href: '/vulkany-kamchatki-yunesko', label: 'Вулканы Камчатки — объект ЮНЕСКО: что входит и как посетить' },
  '/places/vulkan-avachinskij': { href: '/voshozhdenie-na-avachinskij-vulkan', label: 'Восхождение на Авачинский вулкан: высота, сложность, сезон' },
  '/routes/vulkan-mutnovskiy-874283be': { href: '/places/vulkan-mutnovskij', label: 'Вулкан Мутновский: открыт ли маршрут, высота, как доехать' },
};
