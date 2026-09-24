/**
 * lib/services/safety/emsd-quakes.ts — таблица «Последние 10 землетрясений
 * Камчатки с Ml > 4,0» с главной страницы КФ ФИЦ ЕГС РАН (www.emsd.ru).
 *
 * ── Зачем (24.09, решение владельца) ──────────────────────────────────────
 *
 * «нам нужно переключиться на этот ресурс, tg не активен у них». Сейсмику
 * диапазона M4.0–4.9 платформа получала ТОЛЬКО из телеграм-канала EQKam:
 * USGS у нас спрашивается с порогом M5.0 (`ingestUsgs`, minmagnitude=5.0).
 * Канал замолчал — и всё слабее пятёрки перестало существовать для ленты.
 * Пример того же дня: Ml 4.2 21.09 в 03:09 UTC, 110 км от Петропавловска.
 *
 * Сам канал EQKam в своём описании называл резервом emsd.ru — то есть
 * переход не подмена источника, а переход на его же основной адрес.
 *
 * Таблица — СПИСОК последних десяти событий, а не лента новостей. При опросе
 * раз в пять минут пропустить событие между опросами нельзя, пока их не
 * случится больше десяти за пять минут.
 *
 * ── Чего модуль не знает ──────────────────────────────────────────────────
 *
 * Вёрстку живой страницы. Из контейнера разработки www.emsd.ru закрыт, а
 * снимка главной у меня нет — есть только её ТЕКСТ, вставленный владельцем.
 * Поэтому разбор идёт по тексту, а не по тегам: строка таблицы узнаётся по
 * форме «дата время широта долгота глубина магнитуда», какой бы разметкой её
 * ни обернули. Совпадёт ли это с живой страницей, скажет первый прогон на
 * проде: ноль строк — жалоба в `problems`, а не тихая пустая таблица.
 *
 * Только разбор: ни сети, ни БД. Скачивание — `emsd-fetch`, запись — в
 * `seismic-parser`, через общий `saveEvent`.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

/** Главная сайта — там живёт таблица. Одна константа на всю платформу. */
export const EMSD_HOME_URL = 'https://www.emsd.ru/';

/**
 * Грубый конверт региона: Камчатка, Командоры, Северные Курилы с запасом.
 * Не проверка правды (ей нечем быть), а отсев перепутанных колонок и мусора:
 * долгота на месте широты или глубина на месте магнитуды сюда не влезут.
 */
const LAT_MIN = 40;
const LAT_MAX = 66;
const LNG_MIN = 150;
const LNG_MAX = 176;

export interface EmsdQuake {
  /** Время очага UTC, ISO, с точностью до секунды (дробная часть отброшена). */
  timeUtc: string;
  lat: number;
  lng: number;
  depthKm: number;
  ml: number;
  /** Строка таблицы дословно — для описания и разбора. */
  raw: string;
}

export interface EmsdQuakeTable {
  /** Порог из заголовка таблицы («Ml > 4,0» → 4). null — заголовок не разобран. */
  threshold: number | null;
  rows: EmsdQuake[];
  /** Строки, похожие на событие, но не прошедшие проверку, — числом и причиной. */
  rejected: Array<{ raw: string; why: string }>;
  /**
   * Что не получилось. Пустой массив — и только он — значит «разобрано».
   * Ноль строк при живой странице — отказ (смена вёрстки или не та страница),
   * а не «землетрясений не было»: таблица по определению не пустеет.
   */
  problems: string[];
}

const HEADING = /Последние\s+\d+\s+землетрясени[йя][^.]{0,60}?Ml\s*>\s*(\d+(?:[.,]\d+)?)/i;

/**
 * Строка события в плоском тексте:
 *   2026-09-21 03:09:35.9219 52.08 159.24 50 4.2
 * Дробная часть секунд у источника разной длины (.9219, .735, .0004) —
 * поэтому `\d+`, а не фиксированная ширина.
 */
const ROW = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s+(-?\d{1,3}(?:\.\d+)?)\s+(-?\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)\s+(\d(?:\.\d+)?)/g;

/** Сколько текста после заголовка считать таблицей. Десять строк — это ~500 знаков. */
const TABLE_WINDOW = 4000;

export function parseEmsdQuakes(html: string): EmsdQuakeTable {
  const problems: string[] = [];
  const text = decodeHtmlEntities(stripTags(html, ' ')).replace(/[\s ]+/g, ' ');

  const heading = text.match(HEADING);
  if (!heading || heading.index === undefined) {
    // Без заголовка искать строки по всей странице нельзя: на ней могут
    // стоять другие таблицы с той же формой чисел (архив, станции), и мы
    // приняли бы их за свежие события.
    return {
      threshold: null,
      rows: [],
      rejected: [],
      problems: ['заголовок таблицы «Последние … землетрясений … Ml > …» не найден — страница сменилась или пришла не она'],
    };
  }
  const threshold = Number(heading[1].replace(',', '.'));
  const window = text.slice(heading.index, heading.index + TABLE_WINDOW);

  const rows: EmsdQuake[] = [];
  const rejected: Array<{ raw: string; why: string }> = [];
  for (const m of window.matchAll(ROW)) {
    const [raw, y, mo, d, h, mi, s, latS, lngS, depthS, mlS] = m;
    const lat = Number(latS);
    const lng = Number(lngS);
    const depthKm = Number(depthS);
    const ml = Number(mlS);
    const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));

    let why: string | null = null;
    if (Number.isNaN(date.getTime()) || date.getUTCDate() !== +d) why = 'дата не существует';
    else if (lat < LAT_MIN || lat > LAT_MAX) why = `широта ${lat} вне региона`;
    else if (lng < LNG_MIN || lng > LNG_MAX) why = `долгота ${lng} вне региона`;
    else if (depthKm > 700) why = `глубина ${depthKm} км невозможна`;
    else if (ml <= 0 || ml >= 10) why = `магнитуда ${ml} невозможна`;

    if (why) {
      rejected.push({ raw, why });
      continue;
    }
    rows.push({ timeUtc: date.toISOString(), lat, lng, depthKm, ml, raw });
  }

  if (rows.length === 0) {
    problems.push(
      rejected.length > 0
        ? `заголовок таблицы найден, но все ${rejected.length} строк отвергнуты проверкой — вероятно, сменился порядок колонок`
        : 'заголовок таблицы найден, строк событий под ним нет — вёрстка сменилась',
    );
  }

  return { threshold, rows, rejected, problems };
}
