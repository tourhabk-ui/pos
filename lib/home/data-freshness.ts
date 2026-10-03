/**
 * lib/home/data-freshness.ts
 *
 * Насколько свежа обстановка, которую показывает главная.
 *
 * Смысл платформы — не «показать статус», а показать статус, которому можно
 * верить. Значит у живого блока три состояния, а не одно:
 *
 *   свежо      — данные пришли недавно, показываем возраст;
 *   устарело   — источник давно молчит, но старое значение ещё на экране;
 *   недоступно — источника нет вовсе, показывать нечего.
 *
 * Разница между вторым и третьим важнее, чем кажется. Молча показать
 * позавчерашнюю сводку как сегодняшнюю — это ровно то враньё, от которого мы
 * чистили календарь тура: интерфейс выглядит рабочим, а человек принимает
 * решение по данным, которых больше нет.
 *
 * Пороги разные по источникам, потому что источники разной природы:
 * сейсмика идёт потоком и час молчания уже подозрителен, а статус вулкана
 * KVERT меняется редко — сутки тишины там норма.
 */

export type FreshnessState = 'fresh' | 'stale' | 'unavailable';

export interface Freshness {
  state: FreshnessState;
  /** Возраст данных в минутах. null — когда возраст неизвестен. */
  ageMinutes: number | null;
  /** Готовая строка для интерфейса. */
  label: string;
}

/**
 * Через сколько минут молчания источник считается устаревшим.
 * Числа — из природы самих источников, а не из общего «ну пусть час».
 */
export const STALE_AFTER_MINUTES: Record<string, number> = {
  /** Землетрясения идут потоком: час тишины — уже повод не доверять. */
  seismic: 60,
  /** Сводка безопасности собирается кроном примерно ежечасно. */
  safety: 180,
  /** ACC вулканов KVERT меняется редко, сутки тишины — норма. */
  volcano: 1440,
  /** Статусы дорог обновляются по событиям, не по расписанию. */
  roads: 720,
};

const DEFAULT_STALE_AFTER = 180;

/** Русское склонение по числу. Экспорт: «1 событий» на /safety — тот же класс бага. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «5 минут назад», «3 часа назад», «2 дня назад». */
export function humanAge(minutes: number): string {
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

export interface FreshnessInput {
  /** ISO-время последнего обновления источника. null/пусто — источника нет. */
  updatedAt: string | null | undefined;
  /** Ключ источника из STALE_AFTER_MINUTES. */
  source?: string;
  /** Момент «сейчас» — параметром, чтобы функция оставалась чистой. */
  now?: Date;
}

export function dataFreshness({ updatedAt, source, now = new Date() }: FreshnessInput): Freshness {
  if (!updatedAt) {
    return { state: 'unavailable', ageMinutes: null, label: 'Обстановка недоступна' };
  }

  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) {
    // Битая метка времени — это тоже «не знаем», а не «свежо».
    return { state: 'unavailable', ageMinutes: null, label: 'Обстановка недоступна' };
  }

  const ageMinutes = Math.floor((now.getTime() - ts) / 60_000);

  if (ageMinutes < 0) {
    // Время из будущего: рассинхрон часов сервера или битые данные. Доверять
    // такому «свежему» нельзя — честнее сказать, что не знаем.
    return { state: 'unavailable', ageMinutes: null, label: 'Обстановка недоступна' };
  }

  // Скобки существенны: `source && MAP[source]` при пустой строке вернул бы
  // саму строку, а не число. Порог обязан быть числом всегда.
  const limit = (source ? STALE_AFTER_MINUTES[source] : undefined) ?? DEFAULT_STALE_AFTER;

  if (ageMinutes > limit) {
    return { state: 'stale', ageMinutes, label: `Данные ${humanAge(ageMinutes)}` };
  }

  return { state: 'fresh', ageMinutes, label: `Обновлено ${humanAge(ageMinutes)}` };
}

/** Возраст коротко, для тесной плитки: «5 мин назад», «9 ч назад», «2 дн назад». */
export function humanAgeShort(minutes: number): string {
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/**
 * Свежесть одной короткой строкой — для плитки «Радар» на телефоне (владелец
 * 25.09: «экономить место»). Замер на 360px: в строку входит ~16 знаков, и
 * «обновлено 20 мин назад» обрезалось. Поэтому строка — ВОЗРАСТ, а оценку
 * «свежо / устарело» несёт цвет точки на иконке (freshnessDot); полная строка
 * остаётся в aria-label и title. «Не знаем» — словами, без возраста.
 */
export function freshnessShort(f: Freshness): string {
  if (f.state === 'unavailable' || f.ageMinutes === null) return 'нет данных';
  return humanAgeShort(f.ageMinutes);
}

/** Цветовой токен точки. У «недоступно» точки нет вовсе — см. тест. */
export function freshnessDot(state: FreshnessState): string | null {
  if (state === 'fresh') return 'var(--success)';
  if (state === 'stale') return 'var(--warning)';
  return null;
}

/**
 * Порог доли живых маршрутов без линии для офлайн-карты (#1643): больше —
 * предупреждение на `/hub/admin/health` (routes-geometry считает «ok» от
 * 100 − порог).
 *
 * До 03.10 тем же числом жил прибор плитки «Радар» на главной — «офлайн 74%».
 * Владелец снял его («убрать»): радар — про опасность сейчас, а подпись
 * читалась как «ваш офлайн готов на 74%». Доля — забота платформы, и она
 * осталась там, где её чинят; у маршрута его линия подписана на карточке.
 *
 * Константа живёт в этом чистом модуле, а не в сервисе: сервис тянет
 * `lib/db-pool`.
 */
export const GEOMETRY_GAP_WARN_PCT = 20;
