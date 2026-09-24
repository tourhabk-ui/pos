/**
 * lib/services/safety/max-channel.ts — публичная страница канала в мессенджере
 * MAX (`https://max.ru/<канал>`): что на ней есть и можно ли из неё достать
 * посты С ДАТАМИ.
 *
 * ── Зачем (24.09) ─────────────────────────────────────────────────────────
 *
 * Владелец: «бери цунами из MAX kbgsras». КБГС перенёс оперативные сообщения
 * из Telegram в MAX, и там же теперь предупреждения о цунами — самое
 * срочное, что вообще бывает в ленте.
 *
 * ── Почему сперва перепись, а не приём ────────────────────────────────────
 *
 * Канал МЧС в MAX читается у нас с раннера так: страница режется на строки
 * длиннее 40 символов, каждая строка — «пост», дата — «сейчас». Для МЧС это
 * терпимо. Для КБГС — нет: старый пост «Угроза цунами» с витрины канала стал
 * бы СВЕЖЕЙ тревогой цунами для всех туристов. Ложная тревога цунами — это
 * эвакуация без причины и выученное недоверие к настоящей.
 *
 * Поэтому правило приёма будет таким: угрозу принимаем только из поста, у
 * которого есть СВОЯ дата, и только свежего. Нет даты — нет тревоги, и об
 * этом говорится вслух.
 *
 * Какой вид у страницы, неизвестно: из контейнера разработки max.ru закрыт.
 * Возможно, это витрина «откройте в приложении» без единого поста. Модуль ниже
 * — не приём, а ИЗМЕРЕНИЕ: он пробует достать посты с датами общими способами
 * и честно говорит, получилось ли. Его зовёт проба `max-channel-probe`.
 *
 * Только разбор: ни сети, ни БД.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

/** Канал КБГС в MAX. Одна константа на платформу. */
export const MAX_KBGSRAS_URL = 'https://max.ru/kbgsras';

export interface DatedPost {
  id: string | null;
  /** ISO-время поста; только посты С датой попадают сюда. */
  time: string;
  text: string;
}

export interface MaxPageCensus {
  title: string | null;
  /** Признаки устройства страницы — чтобы по ответу понять, что это за страница. */
  signals: {
    scripts: number;
    jsonScripts: number;
    timeTags: number;
    isoTimestamps: number;
    mentionsTsunami: number;
    mentionsEarthquake: number;
  };
  /** Посты, у которых нашлась своя дата. Пусто — принимать угрозы из канала нельзя. */
  datedPosts: DatedPost[];
  /** Текстовые строки страницы ≥ 40 символов — то, что видит раннер МЧС. */
  lines: string[];
  /** Начало плоского текста — чтобы увидеть страницу глазами. */
  textHead: string;
}

const TEXT_KEYS = ['text', 'message', 'body', 'content', 'caption'];
const TIME_KEYS = ['time', 'date', 'created', 'createdAt', 'created_at', 'timestamp', 'ts', 'publishedAt', 'published_at'];
const ID_KEYS = ['id', 'messageId', 'message_id', 'postId', 'post_id'];

/** Время из поля: ISO-строка или эпоха в секундах/миллисекундах. Только правдоподобное. */
function parseTime(v: unknown): string | null {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) ms = Date.parse(v);
  else if (typeof v === 'string' && /^\d{10,13}$/.test(v)) ms = Number(v) > 1e12 ? Number(v) : Number(v) * 1000;
  if (ms === null || Number.isNaN(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  if (y < 2020 || y > 2100) return null;
  return new Date(ms).toISOString();
}

/** Обойти JSON и собрать объекты, похожие на пост: текст плюс время. */
function walkForPosts(node: unknown, out: DatedPost[], depth = 0): void {
  if (depth > 40 || out.length >= 200 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walkForPosts(x, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const textKey = TEXT_KEYS.find((k) => typeof o[k] === 'string' && (o[k] as string).trim().length >= 20);
  const timeKey = TIME_KEYS.find((k) => parseTime(o[k]) !== null);
  if (textKey && timeKey) {
    const idKey = ID_KEYS.find((k) => typeof o[k] === 'string' || typeof o[k] === 'number');
    out.push({
      id: idKey ? String(o[idKey]) : null,
      time: parseTime(o[timeKey]) as string,
      text: (o[textKey] as string).trim(),
    });
  }
  for (const v of Object.values(o)) walkForPosts(v, out, depth + 1);
}

/**
 * Перепись страницы канала. Посты с датами ищутся во встроенном JSON — так
 * обычно отдают данные страницы-приложения. Найти их в разметке по тегам
 * <time> без знания вёрстки нельзя честно: чей это <time> — поста, шапки или
 * подвала, — неизвестно, а приписать дату не тому тексту хуже, чем не найти.
 */
export function censusMaxPage(html: string): MaxPageCensus {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const datedPosts: DatedPost[] = [];
  let jsonScripts = 0;
  for (const [, attrs, body] of scripts) {
    const candidates: string[] = [];
    if (/type=["']application\/(?:ld\+)?json["']/i.test(attrs) || /__NEXT_DATA__/.test(attrs)) {
      candidates.push(body);
    }
    // window.__STATE__ = {...};
    for (const m of body.matchAll(/=\s*(\{[\s\S]{20,}\})\s*;?\s*$/gm)) candidates.push(m[1]);
    for (const c of candidates) {
      try {
        walkForPosts(JSON.parse(c), datedPosts);
        jsonScripts++;
      } catch {
        // Не JSON — не ошибка переписи: скрипт кода, а не данных. Считается
        // только то, что разобралось; число и так стоит в signals.
      }
    }
  }

  const text = decodeHtmlEntities(stripTags(html, '\n'));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 40 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 40) break;
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];

  // Дубли одного поста (встречается дважды в разных ветках JSON) — один раз.
  const uniq = new Map<string, DatedPost>();
  for (const p of datedPosts) uniq.set(`${p.id ?? ''}|${p.time}|${p.text.slice(0, 80)}`, p);

  return {
    title: title ? decodeHtmlEntities(title).trim() : null,
    signals: {
      scripts: scripts.length,
      jsonScripts,
      timeTags: (html.match(/<time\b/gi) ?? []).length,
      isoTimestamps: (html.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? []).length,
      mentionsTsunami: (flat.match(/цунами/gi) ?? []).length,
      mentionsEarthquake: (flat.match(/землетрясени/gi) ?? []).length,
    },
    datedPosts: [...uniq.values()].sort((a, b) => b.time.localeCompare(a.time)),
    lines,
    textHead: flat.slice(0, 1500),
  };
}
