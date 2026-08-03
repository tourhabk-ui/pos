/**
 * Единый словарь подписей тура — ОДИН источник на всю платформу.
 *
 * Повод (аудит 2026-08-03). `ACTIVITY_LABELS` был скопирован в 12 файлов, и
 * копии РАЗОШЛИСЬ — один и тот же тур подписывался по-разному в зависимости от
 * страницы:
 *   • `boat_trip` — пять вариантов: «Сплав», «Сплав / лодка», «Морская
 *     прогулка», «Морские туры», «Морской тур». Два из них — «Сплав» —
 *     сталкивались с `rafting`, то есть морская прогулка выдавалась за сплав;
 *   • `rafting` — «Рафтинг» либо «Сплав». Для тура по Быстрой «Рафтинг» —
 *     прямая неправда: это спокойный семейный сплав, не спортивный рафтинг
 *     (см. миграцию 802);
 *   • `thermal` — четыре варианта; `skiing`/`ski`, `photo`/`photography`,
 *     `hiking`/`trekking` — дубли ключей;
 *   • в одной из копий подпись была набрана вперемешку кириллицей и латиницей
 *     («Фototур») — такое не находится поиском и не читается голосом.
 *
 * Ключи ниже — то, что реально встречается в `operator_tours.activity_type`
 * (`boat_trip`, `eco`, `fishing`, `helicopter`, `rafting`, `trekking`) плюс
 * значения, использовавшиеся в UI. Ничего не выдумано: подписи взяты из
 * CLAUDE.md (§2 чип «Сплав» → rafting, §11 «вертолётная экскурсия») и из
 * существующих формулировок.
 */

/** Тип активности тура → человеческая подпись. */
export const ACTIVITY_LABELS: Record<string, string> = {
  trekking:      'Треккинг',
  fishing:       'Рыбалка',
  thermal:       'Термальные источники',
  helicopter:    'Вертолётная экскурсия',
  boat_trip:     'Морская прогулка',
  bears:         'Наблюдение за медведями',
  rafting:       'Сплав',
  snowmobile:    'Снегоходный тур',
  volcano:       'Восхождение на вулкан',
  eco:           'Экотуризм',
  diving:        'Дайвинг',
  horseback:     'Конный маршрут',
  jeep_safari:   'Джип-сафари',
  skiing:        'Лыжи и скитур',
  kayak:         'Байдарки',
  photography:   'Фототур',
  birdwatching:  'Орнитология',
  cultural:      'Культурный тур',
  winter_hiking: 'Зимний поход',
  // Встречаются у МАРШРУТОВ (kamchatka_routes.activity_type), не только у туров.
  hiking:        'Пеший поход',
  ski:           'Лыжи',
  sightseeing:   'Обзорная экскурсия',
  other:         'Маршрут',
};

/**
 * Короткие подписи — для чипов на плитке каталога, где длинная не помещается.
 * Это ВТОРОЙ РЕГИСТР одного словаря, а не вторая правда: смысл совпадает с
 * полной подписью. Нет короткой — берём полную.
 */
export const ACTIVITY_SHORT: Record<string, string> = {
  thermal:     'Термальные',
  helicopter:  'Вертолёт',
  bears:       'Медведи',
  snowmobile:  'Снегоход',
  boat_trip:   'Море',
  volcano:     'Вулкан',
  photography: 'Фото',
  winter_hiking: 'Зимний поход',
};

/** Тип локации тура → подпись. */
export const LOCATION_LABELS: Record<string, string> = {
  mountain:   'Горы',
  volcano:    'Вулканы',
  hot_spring: 'Горячие источники',
  lake:       'Озёра',
  sea:        'Море',
  river:      'Реки',
  forest:     'Тайга',
  coast:      'Побережье',
};

/**
 * Сложность: подпись + семантический токен цвета (никогда не хардкод-hex).
 * `moderate` и `expert` — синонимы, встречались в отдельных копиях словаря.
 */
export const DIFFICULTY_LABELS: Record<string, { label: string; short: string; color: string }> = {
  easy:     { label: 'Подходит новичкам',  short: 'Лёгкий',     color: 'var(--success)' },
  medium:   { label: 'Средняя сложность',  short: 'Средний',    color: 'var(--warning)' },
  moderate: { label: 'Средняя сложность',  short: 'Средний',    color: 'var(--warning)' },
  hard:     { label: 'Требует подготовки', short: 'Сложный',    color: 'var(--danger)' },
  expert:   { label: 'Только с опытом',    short: 'Экспертный', color: 'var(--danger)' },
};

/** Короткая подпись сложности для чипа. Неизвестное — как есть (§8). */
export function difficultyLabel(level: string | null | undefined, short = false): string {
  if (!level) return '';
  const d = DIFFICULTY_LABELS[level];
  if (!d) return level;
  return short ? d.short : d.label;
}

/** Единица цены. Полная форма — для карточки, короткая — для плитки каталога. */
export const PRICE_UNIT_LABELS: Record<string, string> = {
  per_person:         'за человека',
  per_tour:           'за группу',
  per_day_per_person: 'за чел./день',
};

export const PRICE_UNIT_SHORT: Record<string, string> = {
  per_person:         '/чел.',
  per_tour:           '/группа',
  per_day_per_person: '/чел. в день',
};

/**
 * Подпись активности. Неизвестный тип возвращаем как есть — честнее показать
 * сырое значение, чем выдумать перевод (§8); заодно видно, что словарь отстал.
 */
export function activityLabel(type: string | null | undefined, short = false): string {
  if (!type) return '';
  if (short) return ACTIVITY_SHORT[type] ?? ACTIVITY_LABELS[type] ?? type;
  return ACTIVITY_LABELS[type] ?? type;
}

export function locationLabel(type: string | null | undefined): string {
  if (!type) return '';
  return LOCATION_LABELS[type] ?? type;
}

/**
 * Подпись для поверхностей, где в одном списке лежат и туры, и места (корзина):
 * сначала пробуем тип активности, затем тип локации, иначе — как есть.
 */
export function anyTypeLabel(type: string | null | undefined): string {
  if (!type) return '';
  return ACTIVITY_LABELS[type] ?? LOCATION_LABELS[type] ?? type;
}

export function priceUnitLabel(unit: string | null | undefined, short = false): string {
  const dict = short ? PRICE_UNIT_SHORT : PRICE_UNIT_LABELS;
  return dict[unit ?? ''] ?? (short ? '/чел.' : 'за человека');
}
