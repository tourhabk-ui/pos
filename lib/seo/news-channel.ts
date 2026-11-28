/**
 * Новостной канал Ведара: какой показать и куда вести ссылку (слово владельца
 * 28.11: «в РФ в постах и на сайте ставить канал MAX, в других странах —
 * Telegram»).
 *
 * Два правила, оба без сети и без хранения:
 *  - пост: в тексте, который уходит в канал MAX, корень Telegram-канала
 *    заменяется корнем канала MAX, и наоборот (`adaptNewsChannelLinks`).
 *    Меняется только корень канала: ссылка на конкретный пост
 *    `t.me/kamchatka_real/444` в MAX не живёт, её не трогаем;
 *  - сайт: посетителю из РФ — канал MAX, остальным — Telegram
 *    (`newsChannelForRequest`). Страна по заголовку прокси, если он есть,
 *    иначе по первому языку браузера; не знаем — Telegram, потому что MAX вне
 *    РФ часто недоступен.
 *
 * Адреса — из `ORGANIZATION_PROFILES`, единственного реестра. Переменные
 * `TELEGRAM_CHANNEL_LINK` / `MAX_CHANNEL_LINK` могут переопределить адрес и
 * читаются ТОЛЬКО внутри функций ниже, на сервере: подвал живёт и в клиентском
 * дереве карточки тура, а эти переменные не `NEXT_PUBLIC`. Подвал импортирует
 * отсюда только тип.
 *
 * Разметка организации (`ORGANIZATION_SAME_AS`) этим модулем не меняется:
 * там остаются оба канала.
 */

import { ORGANIZATION_PROFILES } from '@/lib/seo/organization-profiles';
import { htmlLangForPath, ROOT_LANG_HEADER } from '@/lib/i18n/root-lang';

export type NewsChannelDest = 'telegram' | 'max';

/** Ссылка на новостной канал для подвала: адрес и подпись. */
export interface NewsChannelLink {
  href: string;
  label: string;
}

/** Достаточно чтения: подойдут и `Headers`, и заголовки из `next/headers`. */
export type RequestHeaders = Pick<Headers, 'get'>;

export const NEWS_CHANNEL_LABELS: Readonly<Record<NewsChannelDest, string>> = {
  telegram: 'Telegram-канал',
  max: 'Канал в MAX',
};

const ENV_NAME: Readonly<Record<NewsChannelDest, string>> = {
  telegram: 'TELEGRAM_CHANNEL_LINK',
  max: 'MAX_CHANNEL_LINK',
};

const REGISTRY_URL: Readonly<Record<NewsChannelDest, string>> = {
  telegram: ORGANIZATION_PROFILES.telegramChannel,
  max: ORGANIZATION_PROFILES.maxChannel,
};

/** Адрес из переменной принимается, только если это ссылка без пробелов и кавычек. */
const ENV_URL_RE = /^https?:\/\/[^\s"'<>]+$/;
const reportedBadEnv = new Set<string>();

/** Адрес канала назначения: переменная окружения, если задана и годна, иначе реестр. */
function channelUrl(dest: NewsChannelDest): string {
  const name = ENV_NAME[dest];
  const raw = process.env[name]?.trim();
  if (!raw) return REGISTRY_URL[dest];
  if (ENV_URL_RE.test(raw)) return raw;
  if (!reportedBadEnv.has(name)) {
    reportedBadEnv.add(name);
    console.error(`[news-channel] ${name} задана, но это не ссылка http(s) — беру адрес из реестра`);
  }
  return REGISTRY_URL[dest];
}

// ── Посты ────────────────────────────────────────────────────────────────────

/** Перед корнем: начало строки, пробел или разделитель. */
const BEFORE = String.raw`(^|[\s"'(\[<>«])`;
/**
 * Хвост корня: необязательный одиночный «/» и необязательный query/«#».
 * После — не буква, не цифра, не «_» и не «/»: иначе это пост
 * (`/444`, `/s/...`) или другое имя (`kamchatka_realism`).
 */
const TAIL = String.raw`\/?(?:[?#][^\s"'<>]*)?(?![\p{L}\p{N}_\/])`;

const ROOT_RE: Readonly<Record<NewsChannelDest, RegExp>> = {
  // Корни Telegram-канала — их меняем, когда текст уходит в MAX.
  max: new RegExp(
    BEFORE + String.raw`(?:(?:https?:\/\/)?(?:www\.)?t\.me\/kamchatka_real|@kamchatka_real)` + TAIL,
    'giu',
  ),
  // Корни канала MAX — их меняем, когда текст уходит в Telegram.
  telegram: new RegExp(
    BEFORE + String.raw`(?:https?:\/\/)?(?:www\.)?max\.ru\/id4101147649_biz` + TAIL,
    'giu',
  ),
};

const MESSENGER_NAME: Readonly<Record<NewsChannelDest, string>> = { telegram: 'Telegram', max: 'MAX' };

/**
 * Подпись непосредственно перед корнем: «Наш канал в Telegram» или «канал в
 * Telegram», между ней и корнем — только пробелы и один разделитель.
 */
function labelBeforeRe(from: NewsChannelDest): RegExp {
  return new RegExp(
    String.raw`(^|[^\p{L}\p{N}_])((?:Наш )?канал в )${MESSENGER_NAME[from]}(\s*(?:[:—–-]\s*)?)$`,
    'u',
  );
}

/**
 * Текст поста для канала `dest`: корень чужого канала заменён корнем своего.
 * Ссылки на посты, ботов и чужие каналы не меняются; текст без корня
 * возвращается как есть. Новых строк «мы в …» не добавляет.
 */
export function adaptNewsChannelLinks(text: string, dest: NewsChannelDest): string {
  const re = ROOT_RE[dest];
  const from: NewsChannelDest = dest === 'max' ? 'telegram' : 'max';
  const label = labelBeforeRe(from);
  let target: string | null = null;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const index = m.index ?? 0;
    const start = index + m[1].length;
    let head = text.slice(last, start);
    const lab = head.match(label);
    if (lab && lab.index !== undefined) {
      head = head.slice(0, lab.index) + lab[1] + lab[2] + MESSENGER_NAME[dest] + lab[3];
    }
    target ??= channelUrl(dest);
    out += head + target;
    last = index + m[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ── Сайт ─────────────────────────────────────────────────────────────────────

/** Заголовки страны, которые ставят распространённые прокси. Timeweb их сейчас не шлёт. */
const COUNTRY_HEADERS = [
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'x-vercel-ip-country',
  'x-appengine-country',
  'x-country-code',
] as const;

/** Первый (предпочтительный) тег Accept-Language: русский без региона или с регионом RU. */
function prefersRussianInRussia(acceptLanguage: string | null): boolean {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim().toLowerCase();
  if (!first) return false;
  const [lang, ...rest] = first.split('-');
  if (lang !== 'ru') return false;
  const region = rest.find((s) => /^[a-z]{2}$/.test(s) || /^\d{3}$/.test(s));
  return region === undefined || region === 'ru';
}

/**
 * Куда вести посетителя. Раздел `/en` или `/zh` — Telegram при любом языке
 * браузера. Иначе страна из заголовка прокси, если он пришёл; иначе первый
 * язык браузера. Не знаем — Telegram. Ни IP, ни язык не логируются и не
 * сохраняются.
 */
export function newsChannelDestForRequest(headers: RequestHeaders): NewsChannelDest {
  if (htmlLangForPath(headers.get(ROOT_LANG_HEADER)) !== 'ru') return 'telegram';
  for (const name of COUNTRY_HEADERS) {
    const country = headers.get(name)?.trim();
    if (country) return country.toUpperCase() === 'RU' ? 'max' : 'telegram';
  }
  return prefersRussianInRussia(headers.get('accept-language')) ? 'max' : 'telegram';
}

/** Ссылка подвала для этого запроса: адрес и подпись. Только на сервере. */
export function newsChannelForRequest(headers: RequestHeaders): NewsChannelLink {
  const dest = newsChannelDestForRequest(headers);
  return { href: channelUrl(dest), label: NEWS_CHANNEL_LABELS[dest] };
}
