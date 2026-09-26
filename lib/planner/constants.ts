/**
 * Словарь планировщика: зоны, активности, их сезонные окна и русские имена.
 *
 * ── Почему отдельным файлом (20.09) ─────────────────────────────────────
 *
 * Эти константы — ДАННЫЕ, а движок вокруг них умеет писать в базу и звать
 * модели. Пока их читал только он, разницы не было. Перепись материала
 * (`/api/cron/planner-material-census`) обязана считать теми же зонами и
 * активностями, какими движок ищет, — и, импортировав их из `engine`,
 * получила в реестре возможностей `db_write` и `ai`. Перепись, объявленная
 * read-only, числилась умеющей писать и жечь токены: реестр не соврал,
 * соврал бы мой комментарий «только читает».
 *
 * Скопировать список было нельзя: свой разошёлся бы с тем, по которому
 * движок действительно ищет, и перепись отвечала бы про несуществующую
 * платформу. Поэтому переезд, а не копия — `engine` импортирует отсюда и
 * ре-экспортирует, так что ни один прежний читатель не тронут.
 *
 * ЗДЕСЬ НЕ ДОЛЖНО БЫТЬ НИ ОДНОГО ИМПОРТА: перечень возможностей крон-роутов
 * собирается по строкам `from '@/...'` и не отличает импорт типа от импорта
 * значения. Любая зависимость отсюда вернёт переписи чужие умения.
 */

export type ZoneId = 'avachinsky' | 'western' | 'eastern' | 'northern';
export type TransportType = 'walking' | 'jeep' | 'helicopter' | 'boat';
export type FitnessLevel = 'beginner' | 'moderate' | 'active';

export const ZONE_NAMES: Record<ZoneId, string> = {
  avachinsky: 'Авачинская зона',
  western:    'Западная зона',
  eastern:    'Восточная зона',
  northern:   'Северная зона',
};

/**
 * Все зоны движка списком — для Zod-схем и выпадающих списков (зона объекта
 * жилья, миграция 1031: тот же набор держит CHECK в базе).
 */
export const ZONE_IDS = ['avachinsky', 'western', 'eastern', 'northern'] as const satisfies readonly ZoneId[];

/**
 * Где на самом деле ночуют, когда день плана в зоне, где не ночуют.
 * Северная зона — однодневная экскурсия, ночь в Авачинской. Читают двое:
 * оценка проживания движка (ZONE_ACCOMMODATION) и подбор настоящего жилья
 * на ночи плана (lib/planner/trip-extras) — одно правило, не два.
 */
export const ZONE_SLEEPS_IN: Partial<Record<ZoneId, ZoneId>> = {
  northern: 'avachinsky',
};

/** Зона, в которой ночуют, если день плана проходит в `zone`. */
export function sleepZoneOf(zone: ZoneId): ZoneId {
  return ZONE_SLEEPS_IN[zone] ?? zone;
}

export interface ActivityConstraints {
  allowedTransports: TransportType[];
  requiredTransport?: TransportType;      // hard requirement
  defaultTransport: TransportType;
  difficulty: 'easy' | 'moderate' | 'hard';
  minChildAge: number;                    // 0 = any
  childAlternative?: string;
  fitnessRequired: FitnessLevel;
  minDays: number;                        // minimum days to enjoy activity
  bestZones: ZoneId[];
  months: number[];                       // when available
  seasonNote?: string;
  pricePerPerson: [number, number];       // [from, to] RUB
  priceNote?: string;
  requiresPermit?: string;
  requiresLicense?: boolean;
  safetyNotes?: string[];
}

export const ACTIVITY_CONSTRAINTS: Record<string, ActivityConstraints> = {
  trekking: {
    allowedTransports: ['walking', 'jeep'],
    defaultTransport: 'walking',
    difficulty: 'moderate',
    minChildAge: 10,
    childAlternative: 'Лёгкие пешие прогулки в Налычево или окрестностях Паратунки',
    fitnessRequired: 'moderate',
    minDays: 1,
    bestZones: ['avachinsky', 'eastern'],
    months: [6, 7, 8, 9],
    seasonNote: 'Снег на тропах тает к середине июня',
    pricePerPerson: [3000, 8000],
  },
  volcano: {
    allowedTransports: ['jeep', 'helicopter'],
    defaultTransport: 'jeep',
    difficulty: 'hard',
    minChildAge: 12,
    childAlternative: 'Облёт вулканов на вертолёте (от 5 лет)',
    fitnessRequired: 'active',
    minDays: 1,
    bestZones: ['avachinsky'],
    months: [7, 8, 9],
    seasonNote: 'Восхождение на Авачинский 8-10 часов, перепад 1500 м',
    pricePerPerson: [5000, 15000],
    safetyNotes: [
      'Обязательны: трекинговые ботинки, дождевик, слои одежды',
      'Рекомендуется гид — активная вулканическая зона',
    ],
  },
  fishing: {
    allowedTransports: ['jeep', 'boat', 'helicopter'],
    defaultTransport: 'jeep',
    difficulty: 'easy',
    minChildAge: 5,
    fitnessRequired: 'beginner',
    minDays: 2,
    bestZones: ['western', 'avachinsky'],
    months: [6, 7, 8, 9],
    seasonNote: 'Чавыча: июль. Нерка: июль-авг. Кижуч: сентябрь',
    pricePerPerson: [8000, 25000],
    priceNote: 'Многодневные пакеты дешевле: 3 дня от 45 000',
    requiresLicense: true,
  },
  bears: {
    allowedTransports: ['helicopter', 'jeep'],
    defaultTransport: 'helicopter',
    difficulty: 'easy',
    minChildAge: 6,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['eastern', 'avachinsky'],
    months: [7, 8, 9],
    seasonNote: 'Курильское озеро: авг-сен. Речные медведи: июль-сен',
    pricePerPerson: [15000, 45000],
    priceNote: 'Вертолёт до Курильского озера ~300 000/рейс (8 мест)',
    requiresPermit: 'Южно-Камчатский федеральный заказник — бронь за 14 дней',
    safetyNotes: [
      'Только с аккредитованным гидом',
      'Минимальная дистанция от медведей — 50 м',
    ],
  },
  helicopter: {
    allowedTransports: ['helicopter'],
    requiredTransport: 'helicopter',
    defaultTransport: 'helicopter',
    difficulty: 'easy',
    minChildAge: 3,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky', 'northern'],
    months: [5, 6, 7, 8, 9, 10],
    seasonNote: 'Нелётная погода отменяет 30-50% рейсов — нужен запасной день',
    pricePerPerson: [20000, 60000],
    priceNote: 'Ми-8: 120 000-350 000 за рейс (8 мест). Цена на человека зависит от группы',
  },
  geyser: {
    allowedTransports: ['helicopter'],
    requiredTransport: 'helicopter',
    defaultTransport: 'helicopter',
    difficulty: 'easy',
    minChildAge: 8,
    childAlternative: 'Малые гейзеры и кальдера Узон — от 8 лет',
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['northern'],
    months: [6, 7, 8, 9, 10],
    seasonNote: 'Только вертолёт. Бронь Кроноцкого заповедника обязательна',
    pricePerPerson: [30000, 60000],
    priceNote: 'Вертолёт до Долины гейзеров ~250 000/рейс (8 мест). Вход в заповедник ~4 000/чел',
    requiresPermit: 'Кроноцкий заповедник — бронирование через kronoki.ru за 30 дней',
  },
  hot_spring: {
    allowedTransports: ['walking', 'jeep'],
    defaultTransport: 'walking',
    difficulty: 'easy',
    minChildAge: 0,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky', 'eastern'],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    pricePerPerson: [1500, 5000],
  },
  thermal: {
    allowedTransports: ['walking', 'jeep'],
    defaultTransport: 'walking',
    difficulty: 'easy',
    minChildAge: 0,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky'],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    pricePerPerson: [1500, 5000],
  },
  boat_trip: {
    allowedTransports: ['boat'],
    requiredTransport: 'boat',
    defaultTransport: 'boat',
    difficulty: 'easy',
    minChildAge: 5,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky', 'western', 'eastern'],
    months: [5, 6, 7, 8, 9, 10],
    seasonNote: 'Океанские экскурсии зависят от волнения моря',
    pricePerPerson: [8000, 25000],
    priceNote: 'Катер на 8-12 чел: 80 000-200 000/рейс',
  },
  snowmobile: {
    allowedTransports: ['jeep'],
    defaultTransport: 'jeep',
    difficulty: 'moderate',
    minChildAge: 14,
    fitnessRequired: 'moderate',
    minDays: 1,
    bestZones: ['avachinsky', 'western'],
    months: [12, 1, 2, 3, 4],
    seasonNote: 'Только зимний период. Летом недоступно',
    pricePerPerson: [8000, 18000],
  },
  sea: {
    allowedTransports: ['boat', 'walking'],
    defaultTransport: 'boat',
    difficulty: 'easy',
    minChildAge: 5,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky', 'eastern', 'western'],
    months: [5, 6, 7, 8, 9, 10],
    pricePerPerson: [4000, 15000],
  },
  mountain: {
    allowedTransports: ['walking', 'jeep'],
    defaultTransport: 'walking',
    difficulty: 'hard',
    minChildAge: 12,
    childAlternative: 'Лёгкие маршруты в предгорьях Авачинского залива',
    fitnessRequired: 'active',
    minDays: 2,
    bestZones: ['avachinsky', 'northern'],
    months: [7, 8, 9],
    pricePerPerson: [3000, 10000],
    safetyNotes: ['Многодневный треккинг — обязателен опытный гид'],
  },
  river: {
    allowedTransports: ['boat', 'jeep'],
    defaultTransport: 'boat',
    difficulty: 'moderate',
    minChildAge: 8,
    fitnessRequired: 'moderate',
    minDays: 1,
    bestZones: ['western', 'avachinsky'],
    months: [6, 7, 8, 9],
    pricePerPerson: [5000, 18000],
  },
};

/**
 * Ключ активности → слово для человека.
 *
 * Заведено 19.09: заголовок дня без реального тура собирался как
 * `${interest} — ${ZONE_NAMES[zone]}` и показывал туристу ключ движка —
 * «thermal — Авачинская зона». Словарь один на движок и на Кузьмича: второй
 * перевод тех же ключей разошёлся бы с первым.
 */

export const ACTIVITY_NAMES: Record<string, string> = {
  volcano:    'вулканы',
  fishing:    'рыбалка',
  bears:      'медведи',
  helicopter: 'вертолётные экскурсии',
  thermal:    'термальные источники',
  hot_spring: 'горячие источники',
  trekking:   'треккинг',
  boat_trip:  'морские прогулки',
  sea:        'море',
  geyser:     'гейзеры',
  snowmobile: 'снегоходы',
  mountain:   'горы',
  river:      'сплавы',
};

/**
 * Слово оператора в `operator_tours.activity_type` → ключ активности движка.
 *
 * ── Зачем (замер с прода 20.09 через MCP `get_tours`) ────────────────────
 *
 * Живых туров восемь. Семь — `fishing`, восьмой — «Сплав по реке Быстрая» с
 * типом **`rafting`**, которого в `ACTIVITY_CONSTRAINTS` нет вовсе. Отбор
 * материала сравнивает тип ТОЧНЫМ равенством, значит этот тур невидим
 * планировщику принципиально: в любой месяц, при любых интересах. Живой тур
 * за 13 000 ₽ с ближайшей датой 20 сентября нельзя было получить в плане
 * никак.
 *
 * Переименовывать данные оператора нельзя — это его слово о своём туре.
 * Заводить `rafting` отдельной активностью тоже: сплав у нас уже есть под
 * ключом `river`, и два ключа об одном разошлись бы сезонами и зонами.
 * Остаётся перевод на входе, в одном месте.
 *
 * Список НЕ гипотетический и расти должен по замеру: новый тип, который
 * заведёт оператор, сюда попадает после того, как его увидела перепись
 * `planner-material-census`, а не по догадке о том, что он может написать.
 */
export const ACTIVITY_ALIASES: Record<string, string> = {
  rafting: 'river',
};

/**
 * Какие слова оператора считать этой активностью. Сам ключ — всегда первым:
 * тур, названный ровно так, как зовётся активность, ничем не хуже.
 */
export function rawTypesFor(engineKey: string): string[] {
  const aliases = Object.entries(ACTIVITY_ALIASES)
    .filter(([, key]) => key === engineKey)
    .map(([raw]) => raw);
  return [engineKey, ...aliases];
}

/** Слово оператора → ключ движка. Не знаем перевода — слово остаётся собой. */
export function normalizeActivity(raw: string): string {
  return ACTIVITY_ALIASES[raw] ?? raw;
}
