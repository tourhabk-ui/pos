/**
 * Разбор публичных источников потенциального партнёра: сайт и Telegram-канал
 * (#66, фаза 1 — «нужен парсер сайтов и тг каналов», владелец 15.08).
 *
 * Модуль ЧИСТЫЙ: на вход HTML, на выход структура. Сети здесь нет — и это
 * не эстетика, а необходимость: t.me с Timeweb гео-закрыт (то же, с чем
 * живёт safety-ingest), поэтому HTML канала приносит GitHub Actions, а
 * сервер только разбирает. Один разборщик обслуживает оба пути доставки.
 *
 * Что извлекаем детерминированно, без модели: контакты (телефон, почта,
 * Telegram, WhatsApp, сайт) и цены — регулярками; активности — по НАШЕМУ
 * словарю из lib/planner-constants (ACTIVITY_LABEL). Свой список активностей
 * здесь заводить нельзя: он разойдётся с каталогом, и «сплав» партнёра
 * перестанет совпадать со «сплавом» платформы.
 *
 * Модель может пригодиться позже — для текста обращения. Но факты о партнёре
 * берём разбором: самоотчётам модели про телефоны и цены не верим (§8).
 */

import { ACTIVITY_LABEL } from '@/lib/planner-constants';
import { decodeHtmlEntities } from '@/lib/html/entities';

export interface ProspectContacts {
  phones: string[];
  emails: string[];
  telegram: string[];
  whatsapp: string[];
  websites: string[];
}

export interface ProspectSignals {
  /** Канонические id активностей из ACTIVITY_LABEL, найденные в тексте. */
  activities: string[];
  /** Упомянутые цены в рублях (числа), по возрастанию. */
  prices: number[];
  /** Заголовок страницы/канала, если распознан. */
  title: string | null;
  /** Короткое описание (og:description / описание канала). */
  description: string | null;
}

export interface ProspectProfile extends ProspectSignals {
  contacts: ProspectContacts;
  /** Сколько текста реально разобрали — чтобы отличить пустую страницу от богатой. */
  textLength: number;
}

// ── Слова-приметы активностей ────────────────────────────────────────────────
//
// Ключ — канонический id из ACTIVITY_LABEL, значения — то, как об этом пишут
// операторы. Список намеренно узкий: лучше не распознать, чем приписать
// партнёру активность, которой у него нет (обращение с чужой активностью
// выглядит как рассылка).
const ACTIVITY_HINTS: Record<string, string[]> = {
  fishing:    ['рыбалк', 'рыболов', 'чавыч', 'кижуч', 'нерк', 'голец', 'микиж', 'хариус', 'спиннинг'],
  rafting:    ['сплав', 'рафтинг', 'рафт'],
  trekking:   ['треккинг', 'трекинг', 'поход', 'восхожден', 'пеш'],
  volcano:    ['вулкан', 'сопк', 'кратер'],
  bears:      ['медвед', 'курильское озеро'],
  helicopter: ['вертолёт', 'вертолет', 'ми-8'],
  snowmobile: ['снегоход', 'ски-ду', 'скиду'],
  boat_trip:  ['морская прогулка', 'морские прогулки', 'катер', 'яхт', 'китов', 'касатк', 'косатк'],
  hot_spring: ['термальн', 'горячие источник', 'горячий источник', 'купель'],
  geyser:     ['гейзер'],
  sea:        ['халактырск', 'побереж', 'океан'],
  mountain:   ['горнолыж', 'ски-тур', 'фрирайд'],
};

/** Вырезает скрипты, стили и теги; схлопывает пробелы. */
export function htmlToText(html: string): string {
  const withoutTags = html
    // `[^>]*` в ЗАКРЫВАЮЩЕМ теге: браузер принимает `</script >`, `</script\n>`
    // и даже `</script foo>` — атрибуты закрывающего тега он просто
    // игнорирует. Пока регулярка требовала ровно `</script>`, тело скрипта
    // утекало в «текст страницы», а оттуда могло уехать в промпт (две
    // итерации находок CodeQL на PR #1232).
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    // Незакрытый script/style в обрезанном по потолку HTML: хвост до конца
    // документа — тоже не текст страницы.
    .replace(/<script\b[^>]*>[\s\S]*$/i, ' ')
    .replace(/<style\b[^>]*>[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  // Здесь жила третья правильная копия однопроходного декодера. Сведена на
  // общий (lib/html/entities); набор там шире, поэтому «ёлочки» и длинные
  // тире теперь разворачиваются, а не остаются записью вида `&laquo;`.
  return decodeHtmlEntities(withoutTags)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
    'i',
  );
  const m = html.match(re) ?? html.match(alt);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

/** Нормализация российского номера к +7XXXXXXXXXX. Мусор отбрасываем. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith('9')) return `+7${digits}`;
  return null;
}

export function extractContacts(text: string, html = ''): ProspectContacts {
  const source = `${text}\n${html}`;

  const phones = new Set<string>();
  // Российские номера в любых разделителях; год и цену так не поймать —
  // требуем 11 цифр с 7/8 либо 10 с девятки.
  for (const m of source.matchAll(/(?:\+7|8|7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g)) {
    const p = normalizePhone(m[0]);
    if (p) phones.add(p);
  }

  const emails = new Set<string>();
  for (const m of source.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    emails.add(m[0].toLowerCase());
  }

  const telegram = new Set<string>();
  for (const m of source.matchAll(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_+]{4,32})/gi)) {
    const handle = m[1];
    // t.me/s/<channel> — это веб-превью, а не адрес аккаунта.
    if (handle && handle.toLowerCase() !== 's') telegram.add(handle);
  }
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_]{5,32})\b/g)) {
    if (m[1]) telegram.add(m[1]);
  }

  const whatsapp = new Set<string>();
  for (const m of source.matchAll(/wa\.me\/(\d{10,15})/gi)) {
    if (m[1]) whatsapp.add(`+${m[1]}`);
  }

  const websites = new Set<string>();
  for (const m of source.matchAll(/https?:\/\/([a-z0-9-]+\.(?:ru|com|рф|org|net|su))(?:\/[^\s"'<>]*)?/gi)) {
    const host = m[1]?.toLowerCase();
    // Соцсети и мессенджеры — это контакт, а не сайт партнёра.
    if (host && !/^(t\.me|vk\.com|wa\.me|instagram\.com|facebook\.com|max\.ru|youtube\.com)$/.test(host)) {
      websites.add(host);
    }
  }

  return {
    phones: [...phones],
    emails: [...emails],
    telegram: [...telegram],
    whatsapp: [...whatsapp],
    websites: [...websites],
  };
}

export function detectActivities(text: string): string[] {
  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (const [id, hints] of Object.entries(ACTIVITY_HINTS)) {
    if (!(id in ACTIVITY_LABEL)) continue; // словарь платформы — единственный источник
    if (hints.some((h) => haystack.includes(h))) found.push(id);
  }
  return found;
}

/**
 * Цены в рублях. Требуем валютную примету рядом — иначе в «цены» попадут
 * годы, высоты вулканов и номера телефонов.
 */
export function extractPrices(text: string): number[] {
  const prices = new Set<number>();
  for (const m of text.matchAll(/(\d[\d\s ]{2,9})\s*(?:руб|₽|р\.|рублей)/gi)) {
    const value = Number(m[1].replace(/[\s ]/g, ''));
    if (Number.isFinite(value) && value >= 500 && value <= 5_000_000) prices.add(value);
  }
  return [...prices].sort((a, b) => a - b);
}

/** Разбор обычного сайта оператора. */
export function parseOperatorSite(html: string): ProspectProfile {
  const text = htmlToText(html);
  const title = metaContent(html, 'og:title')
    ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    ?? null;

  return {
    title: title ? htmlToText(title).slice(0, 200) : null,
    description: metaContent(html, 'og:description') ?? metaContent(html, 'description'),
    activities: detectActivities(text),
    prices: extractPrices(text),
    contacts: extractContacts(text, html),
    textLength: text.length,
  };
}

export interface TgChannelProfile extends ProspectProfile {
  channel: string | null;
  /** Тексты последних постов — по ним видно, что партнёр реально проводит. */
  posts: string[];
}

/**
 * Разбор ПУБЛИЧНОГО веб-превью Telegram-канала (t.me/s/<name>).
 *
 * Только публичное превью: закрытые каналы и личные переписки сюда не
 * попадают by construction — читаем ровно то, что канал показывает любому
 * прохожему без авторизации.
 */
export function parseTelegramChannel(html: string, channelHint?: string): TgChannelProfile {
  const posts: string[] = [];
  for (const m of html.matchAll(
    /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  )) {
    const post = htmlToText(m[1] ?? '');
    if (post) posts.push(post);
  }

  const channel = channelHint
    ?? html.match(/tgme_channel_info_header_username[^>]*>[\s\S]*?@([A-Za-z0-9_]{4,32})/i)?.[1]
    ?? html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]{4,32})/i)?.[1]
    ?? null;

  const title = metaContent(html, 'og:title');
  const description = metaContent(html, 'og:description');

  // Активности и цены ищем по постам и описанию: шапка канала часто пустая,
  // а «сплав завтра, два места» лежит именно в постах.
  const corpus = [title ?? '', description ?? '', ...posts].join('\n');

  return {
    channel,
    posts,
    title,
    description,
    activities: detectActivities(corpus),
    prices: extractPrices(corpus),
    contacts: extractContacts(corpus, html),
    textLength: corpus.length,
  };
}

/**
 * Профиль кандидата: одна-две активности — это тот самый малый оператор,
 * которого искал владелец. Ноль активностей — не значит «нет»: значит, по
 * публичному тексту не поняли, и решать человеку.
 */
export function prospectSize(activities: string[]): 'small' | 'multi' | 'unknown' {
  if (activities.length === 0) return 'unknown';
  return activities.length <= 2 ? 'small' : 'multi';
}
