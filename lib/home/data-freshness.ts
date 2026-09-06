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

/** Цветовой токен точки. У «недоступно» точки нет вовсе — см. тест. */
export function freshnessDot(state: FreshnessState): string | null {
  if (state === 'fresh') return 'var(--success)';
  if (state === 'stale') return 'var(--warning)';
  return null;
}

/* ── Наличие ЛИНИИ у маршрута для офлайн-карты (#1643) ──────────────────────
 *
 * Свежесть отвечает «можно ли верить обстановке», этот прибор — «есть ли на
 * экране без связи хоть что-то, кроме названия». Маршрут без линии офлайн не
 * покажет ничего: человек в поле остаётся с бумажкой. Доля таких маршрутов —
 * такой же прибор главной, как возраст сводки: её показывают, а не подразумевают.
 *
 * ── Почему «линия», а не «трек» ────────────────────────────────────────────
 *
 * Первая редакция подписывала эту цифру словами «Трек для офлайн-карты есть у
 * N% маршрутов», а считала её по `HAS_TRACK_SQL` — «geometry не NULL и точек
 * больше одной». Это разные утверждения, и разница дорогая.
 *
 * В §12 «трек» — записанный род линии, который ОДИН даёт право обещать
 * ведение; набросок прямыми (миграция 168) и линия, пришедшая скрейпом,
 * понижены решением владельца 17.08 и рисуются пунктиром именно потому, что
 * ведения не обещают. По замеру 04.09 из 392 живых маршрутов скрейп даёт 252,
 * синтетика 10 — то есть подавляющее большинство того, что счётчик засчитал бы
 * в «трек». Подпись обещала бы ведение там, где платформа его сознательно не
 * обещает, и цифра встала бы в один ряд с «778 местами» и «20 турами».
 *
 * Право вести решает `lib/routes/navigability`, и одним запросом оно не
 * считается: ему нужны путевые точки, улика записи, способ передвижения и род
 * паспорта на КАЖДЫЙ маршрут. Поэтому прибор главной говорит ровно то, что
 * знает SQL: линия есть или её нет. Сколько из этих линий имеет право вести —
 * другой вопрос и другая поверхность.
 *
 * Три состояния, как у свежести: «хорошо», «плохо», «не посчитано». Третье
 * не равно первому: упавший запрос или пустой каталог не рисуют зелёной точки.
 */

export type CoverageState = 'ok' | 'warning' | 'unknown';

export interface GeometryCoverage {
  state: CoverageState;
  /** Доля маршрутов, у которых линия есть, целые проценты. null — посчитать нечем. */
  pct: number | null;
  /** Готовая строка для интерфейса. */
  label: string;
}

/**
 * Порог тревоги: больше этой доли маршрутов без линии — предупреждение.
 * Одно число на все поверхности: карточка `/hub/admin/health` считает «ok»
 * от него же (100 − порог).
 *
 * Константа живёт ЗДЕСЬ, а не в сервисе, и это не оплошность слоёв: этот
 * модуль чистый, а `lib/services/routes/routes-geometry-health` тянет
 * `lib/db-pool`. Перенос константы туда затащил бы драйвер БД в клиентский
 * бандл главной — импорт идёт из `'use client'`-компонента.
 */
export const GEOMETRY_GAP_WARN_PCT = 20;

export interface GeometryCoverageInput {
  /** Живых маршрутов всего. null — запрос не выполнился. */
  total: number | null;
  /** Из них без линии, пригодной для показа офлайн. null — запрос не выполнился. */
  withoutTrack: number | null;
}

const COVERAGE_UNKNOWN: GeometryCoverage = {
  state: 'unknown',
  pct: null,
  label: 'Линии маршрутов для офлайн-карты не посчитаны',
};

function isCount(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

export function geometryCoverage({ total, withoutTrack }: GeometryCoverageInput): GeometryCoverage {
  if (!isCount(total) || !isCount(withoutTrack)) return COVERAGE_UNKNOWN;
  // Ноль маршрутов — не «100% покрытие», а отсутствие материала для оценки
  // (§4.0: ноль результатов при нулевом входе — отказ, не успех).
  if (total === 0) return COVERAGE_UNKNOWN;
  // Часть больше целого — данные противоречат себе; из них ничего не следует.
  if (withoutTrack > total) return COVERAGE_UNKNOWN;

  const gapPct = (withoutTrack / total) * 100;
  const pct = Math.round(100 - gapPct);

  if (gapPct > GEOMETRY_GAP_WARN_PCT) {
    // Владелец 06.09: порог 20% давно пройден (106 из 392, ~27%), и при
    // формулировке «Без линии N маршрутов из M» турист видел бы её на
    // каждом заходе на главную как алярм. Решение — оставить на главной, но
    // мягче: та же честная цифра (§4.0 — не прячем долю), только с
    // положительного конца и без счёта отсутствующего впереди фразы. Точка
    // (coverageDot) остаётся цвета предупреждения — кто присматривается,
    // видит состояние; текст никого не пугает при беглом взгляде.
    return {
      state: 'warning',
      pct,
      label: `Линия для офлайн-карты готова у ${pct}% маршрутов — остальные доразмечаем`,
    };
  }

  return {
    state: 'ok',
    pct,
    label: `Линия для офлайн-карты есть у ${pct}% маршрутов`,
  };
}

/** Точка покрытия по тем же правилам, что и у свежести: «не посчитано» — без точки. */
export function coverageDot(state: CoverageState): string | null {
  if (state === 'ok') return 'var(--success)';
  if (state === 'warning') return 'var(--warning)';
  return null;
}
