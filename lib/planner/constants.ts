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

/**
 * Зоны планера. `southern` — Курильское озеро и юг края (слово владельца 19.11
 * «1 отдельная зона», #3394 п.3): до этого день «Медведи» вставал в Авачинской
 * зоне с разрешением Южно-Камчатского заказника, а все туры к медведям на
 * платформе — на Курильское озеро. Зона планера — не зона места в базе:
 * `places.zone` Курильского озера — `western` по району (тревоги МЧС приходят
 * по районам), и её не трогаем; южную зону планер выводит из широты
 * (`SOUTHERN_ZONE_MAX_LAT`, lib/planner/zone-match).
 */
export type ZoneId = 'avachinsky' | 'western' | 'eastern' | 'northern' | 'southern';
export type TransportType = 'walking' | 'jeep' | 'helicopter' | 'boat';
export type FitnessLevel = 'beginner' | 'moderate' | 'active';
export type BudgetTier = 'economy' | 'comfort' | 'premium';
export type DayType = 'arrival' | 'activity' | 'travel' | 'rest' | 'buffer' | 'departure';

export const ZONE_NAMES: Record<ZoneId, string> = {
  avachinsky: 'Авачинская зона',
  western:    'Западная зона',
  eastern:    'Восточная зона',
  northern:   'Северная зона',
  southern:   'Южная зона (Курильское озеро)',
};

/**
 * Все зоны движка списком — для Zod-схем и выпадающих списков (зона объекта
 * жилья, миграция 1031: тот же набор держит CHECK в базе).
 */
export const ZONE_IDS = ['avachinsky', 'western', 'eastern', 'northern'] as const satisfies readonly ZoneId[];

/**
 * Все зоны планера, с южной (#3394 п.3). Жилья в южной зоне план не ищет —
 * ночь там в Авачинской (`ZONE_SLEEPS_IN`), поэтому список зон жилья (`ZONE_IDS`,
 * CHECK миграции 1031) прежний, а день плана и его проверки знают и южную.
 */
export const PLANNER_ZONE_IDS = [...ZONE_IDS, 'southern'] as const satisfies readonly ZoneId[];

/**
 * Южнее этой широты — южная зона планера: Курильское озеро (51,46), Паужетка
 * (51,47), Кошелев, Камбальный. Ходутка (52,06) и Асача (52,36) — севернее,
 * они в Авачинской зоне, куда и ходят от Паратунки.
 */
export const SOUTHERN_ZONE_MAX_LAT = 51.75;

/**
 * Зоны тревог дня плана. Тревоги МЧС и метео адресуются зонами места по
 * району (`places.zone`), а Курильское озеро там — `western`
 * (Усть-Большерецкий район, миграция 1294). День южной зоны получает и
 * тревоги Западной: иначе предупреждение о Курильском озере не дошло бы до
 * дня у Курильского озера.
 */
export function alertZonesOf(zone: ZoneId): ZoneId[] {
  return zone === 'southern' ? ['southern', 'western'] : [zone];
}

/**
 * Где на самом деле ночуют, когда день плана в зоне, где не ночуют.
 * Северная зона — однодневная экскурсия, ночь в Авачинской. Читают двое:
 * строки проживания сметы (lib/planner/estimate, nightZoneOf) и подбор
 * настоящего жилья на ночи плана (lib/planner/trip-extras) — одно правило,
 * не два.
 */
export const ZONE_SLEEPS_IN: Partial<Record<ZoneId, ZoneId>> = {
  northern: 'avachinsky',
  // Южная зона: день вертолётом или многодневный тур со своим ночлегом —
  // жильё план ищет в Авачинской (#3394 п.3).
  southern: 'avachinsky',
};

/** Зона, в которой ночуют, если день плана проходит в `zone`. */
export function sleepZoneOf(zone: ZoneId): ZoneId {
  return ZONE_SLEEPS_IN[zone] ?? zone;
}

/**
 * Зона ночи дня плана (аудит планировщика 07.11, E11). День переезда несёт
 * зону, ОТКУДА едут (движок ставит ему `zone: prevZone`), а ночует человек уже
 * там, КУДА приехал, — в зоне следующего дня. До 07.11 ночь после переезда в
 * Западную зону считалась по цене Авачинской, и жильё на неё искалось там же.
 * Следующего дня нет — зона самого дня. Читают двое, как и sleepZoneOf: смета
 * (lib/planner/estimate) и стоянки жилья (lib/planner/trip-extras).
 */
export function nightZoneOf(day: { type: string; zone: ZoneId }, next?: { zone: ZoneId } | null): ZoneId {
  return sleepZoneOf(day.type === 'travel' && next ? next.zone : day.zone);
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
  requiresPermit?: string;
  requiresLicense?: boolean;
  safetyNotes?: string[];
  /**
   * Совет по снаряжению, верный только в месяцы `months` (#3347, 14.11).
   * «Трекинговые ботинки, дождевик» стоял на дне «Вулканы» и в феврале — рядом
   * с предупреждением, что это не сезон. Вне сезона день говорит
   * OFF_SEASON_GEAR_NOTE: снаряжение называет оператор.
   */
  seasonGearNote?: string;
}

/** Вместо совета по снаряжению, когда день стоит вне сезона занятия. */
export const OFF_SEASON_GEAR_NOTE =
  'Снаряжение на это время года назовёт оператор: наш список — для сезона, а сейчас не сезон.';

/**
 * Советы дня по занятию. Совет по снаряжению — только в сезон занятия;
 * вне сезона вместо него сказано, что список называет оператор.
 */
export function activityDayNotes(
  c: Pick<ActivityConstraints, 'months' | 'safetyNotes' | 'seasonGearNote'>,
  month: number,
): string[] {
  const notes: string[] = [];
  if (c.seasonGearNote) notes.push(c.months.includes(month) ? c.seasonGearNote : OFF_SEASON_GEAR_NOTE);
  if (c.safetyNotes) notes.push(...c.safetyNotes);
  return notes;
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
    seasonGearNote: 'Обязательны: трекинговые ботинки, дождевик, слои одежды',
    safetyNotes: [
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
    requiresLicense: true,
  },
  bears: {
    allowedTransports: ['helicopter', 'jeep'],
    defaultTransport: 'helicopter',
    difficulty: 'easy',
    minChildAge: 6,
    fitnessRequired: 'beginner',
    minDays: 1,
    // Все туры к медведям на платформе — на Курильское озеро (сверка 19.11):
    // день «Медведи» в Авачинской зоне был без тура и с чужим разрешением.
    bestZones: ['southern'],
    months: [7, 8, 9],
    seasonNote: 'Курильское озеро: авг-сен. Речные медведи: июль-сен',
    requiresPermit: 'Южно-Камчатский федеральный заказник',
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
  },
  geyser: {
    allowedTransports: ['helicopter'],
    requiredTransport: 'helicopter',
    defaultTransport: 'helicopter',
    difficulty: 'easy',
    minChildAge: 8,
    // До 14.11 здесь стояло «Малые гейзеры и кальдера Узон — от 8 лет» —
    // альтернатива ребёнку младше 8 лет с тем же порогом 8 лет (разбор
    // планера, движок-14). Возраст — по нашей же таблице `helicopter`.
    childAlternative: 'Обзорная вертолётная экскурсия без высадки у гейзеров — от 3 лет',
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['northern'],
    months: [6, 7, 8, 9, 10],
    seasonNote: 'Только вертолёт. Бронь Кроноцкого заповедника обязательна',
    requiresPermit: 'Кроноцкий заповедник',
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
  },
  // `thermal` (слово чата и Кузьмича, «термальные») и `hot_spring` (плитка
  // сайта) — одно занятие: правила одни, иначе сайт и чат по одним словам
  // строили разные планы (разбор 14.11, Кузьмич-9: у чата не было восточной
  // зоны). Туры оператора с типом `thermal` идут под ключом `hot_spring`
  // (ACTIVITY_ALIASES ниже), а под ключом `thermal` — своим словом.
  thermal: {
    allowedTransports: ['walking', 'jeep'],
    defaultTransport: 'walking',
    difficulty: 'easy',
    minChildAge: 0,
    fitnessRequired: 'beginner',
    minDays: 1,
    bestZones: ['avachinsky', 'eastern'],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
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
  // Разбор 14.11 (Кузьмич-9) и замер с прода через MCP `get_tours`: пять
  // живых туров к источникам (Зеленовские озерки, Малки, Дачные, «термальный
  // маршрут») записаны операторами как `thermal`, а планировщик сайта
  // спрашивает движок плиткой `hot_spring` («Горячие источники»). Отбор по
  // точному равенству не видел их ни одного: сайт не ставил в план ни одного
  // тура к источникам.
  thermal: 'hot_spring',
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
