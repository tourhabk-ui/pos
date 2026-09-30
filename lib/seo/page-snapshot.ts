/**
 * lib/seo/page-snapshot.ts — что видит поисковик на одной HTML-странице.
 *
 * Чистая функция над текстом ответа: без сети и без DOM-библиотек, чтобы её
 * можно было проверить тестом и позвать из роута на проде. Разбор регэкспами
 * намеренно грубый — это перепись признаков, а не браузер: заголовок, описание,
 * canonical, H1-H3, микроразметка, картинки без alt, телефоны и почта.
 *
 * Чего нет в разметке — то `null` или пустой список, а не догадка (§4.0):
 * «description отсутствует» и «description не нашли» здесь одно и то же
 * только потому, что страница целиком у нас в руках.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export interface PageSnapshot {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  viewport: boolean;
  generator: string | null;
  h1: string[];
  h2: string[];
  h3: string[];
  og: Record<string, string>;
  jsonld_types: string[];
  jsonld_invalid: number;
  images_total: number;
  images_without_alt: number;
  internal_links: number;
  external_hosts: string[];
  phones: string[];
  emails: string[];
  counters: string[];
  words: number;
}

const MAX_HEADINGS = 40;

function text(html: string): string {
  return decodeHtmlEntities(stripTags(html, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return null;
  return decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, key) ?? '').toLowerCase() === value) return attr(tag, 'content');
  }
  return null;
}

function headings(html: string, level: 1 | 2 | 3): string[] {
  const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi');
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const t = text(m[1]);
    if (t) out.push(t.slice(0, 160));
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

function jsonldTypes(html: string): { types: string[]; invalid: number } {
  const types = new Set<string>();
  let invalid = 0;
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      const t = rec['@type'];
      if (typeof t === 'string') types.add(t);
      else if (Array.isArray(t)) t.forEach((x) => { if (typeof x === 'string') types.add(x); });
      if (rec['@graph']) collect(rec['@graph']);
    }
  };
  // Закрывающий тег — как у браузера: `</script >` и `</script foo>` тоже конец.
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    try { collect(JSON.parse(m[1])); } catch { invalid += 1; }
  }
  return { types: [...types].sort(), invalid };
}

/**
 * Признаки счётчиков в тексте страницы. Это поиск подстроки в HTML, а не
 * проверка адреса: судить по нему, чей это хост, нельзя и не нужно — вопрос
 * только «стоит ли на странице метрика». Регэкспы по домену тут не нужны
 * (CodeQL справедливо читает их как проверку URL без якоря).
 */
const COUNTER_MARKERS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['yandex_metrika', ['mc.yandex.ru', 'ym(']],
  ['google_analytics', ['googletagmanager.com', 'google-analytics.com']],
  ['top_mail_ru', ['top-fwz1.mail.ru', 'top.mail.ru']],
  ['vk_pixel', ['vk.com/rtrg', 'vk.ru/rtrg']],
];

/** Снимок страницы. `pageUrl` нужен, чтобы отличить свои ссылки от чужих. */
export function snapshotPage(html: string, pageUrl: string): PageSnapshot {
  const origin = new URL(pageUrl);
  const ownHost = origin.hostname.replace(/^www\./, '');

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) ?? [])
    .find((t) => (attr(t, 'rel') ?? '').toLowerCase() === 'canonical');

  const og: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const p = (attr(tag, 'property') ?? '').toLowerCase();
    const c = attr(tag, 'content');
    if (p.startsWith('og:') && c) og[p] = c.slice(0, 200);
  }

  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const withoutAlt = imgs.filter((t) => !(attr(t, 'alt') ?? '').trim()).length;

  let internal = 0;
  const external = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    if (/^tel:/i.test(href)) { phones.add(href.slice(4).replace(/[^\d+]/g, '')); continue; }
    if (/^mailto:/i.test(href)) { emails.add(href.slice(7).split('?')[0].toLowerCase()); continue; }
    if (/^(#|javascript:)/i.test(href)) continue;
    try {
      const u = new URL(href, origin);
      if (u.hostname.replace(/^www\./, '') === ownHost) internal += 1;
      else if (/^https?:$/.test(u.protocol)) external.add(u.hostname);
    } catch { /* битая ссылка — не наша забота здесь */ }
  }

  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  // stripTags снимает script и style вместе с телом — отдельной чистки не нужно.
  const visible = text(body);
  for (const m of visible.matchAll(/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g)) {
    phones.add(m[0].replace(/[^\d+]/g, '').replace(/^8/, '+7'));
  }
  for (const m of visible.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) emails.add(m[0].toLowerCase());

  const ld = jsonldTypes(html);
  const lower = html.toLowerCase();

  return {
    title: titleMatch ? text(titleMatch[1]) || null : null,
    description: metaContent(html, 'name', 'description'),
    canonical: canonicalTag ? attr(canonicalTag, 'href') : null,
    robots: metaContent(html, 'name', 'robots'),
    lang: attr(htmlTag, 'lang'),
    viewport: metaContent(html, 'name', 'viewport') !== null,
    generator: metaContent(html, 'name', 'generator'),
    h1: headings(html, 1),
    h2: headings(html, 2),
    h3: headings(html, 3),
    og,
    jsonld_types: ld.types,
    jsonld_invalid: ld.invalid,
    images_total: imgs.length,
    images_without_alt: withoutAlt,
    internal_links: internal,
    external_hosts: [...external].sort().slice(0, 40),
    phones: [...phones].sort(),
    emails: [...emails].sort(),
    counters: COUNTER_MARKERS.filter(([, marks]) => marks.some((m) => lower.includes(m))).map(([k]) => k),
    words: visible ? visible.split(' ').length : 0,
  };
}

/** Ссылки на страницы туров из листинга: только свой хост, только шаблон карточки. */
export function tourLinks(html: string, listingUrl: string, pattern: RegExp, limit: number): string[] {
  const base = new URL(listingUrl);
  const host = base.hostname.replace(/^www\./, '');
  const out = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      const u = new URL(href, base);
      if (u.hostname.replace(/^www\./, '') !== host) continue;
      if (!pattern.test(u.pathname)) continue;
      out.add(`${base.protocol}//${base.hostname}${u.pathname}`);
    } catch { /* пропускаем */ }
    if (out.size >= limit) break;
  }
  return [...out];
}
