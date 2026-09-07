/**
 * lib/agents/scout-telegram.ts — Telegram-канал как источник разведчика.
 *
 * Читается ТОЛЬКО публичное веб-превью `https://t.me/s/<канал>` — то, что
 * канал показывает любому прохожему без авторизации. Закрытые каналы и
 * ссылки-приглашения (`t.me/+…`) сюда не попадают по построению: у них нет
 * превью, и читать их значило бы вступать в чат от чужого имени.
 *
 * Разбор — по тем же классам разметки, что уже читают сейсмо-слой
 * (lib/services/safety/seismic-parser.ts) и разбор кандидатов
 * (lib/partners/prospect-parse.ts): `tgme_widget_message_text` — текст
 * поста, `a.tgme_widget_message_date` — постоянная ссылка на пост.
 *
 * Пост становится «сигналом» разведчика как заголовок: первая строка текста
 * (до 140 символов) плюс ссылка. Дальше он идёт тем же путём, что запись
 * RSS: ворота честности, дедуп, синтез. Ничего из поста не пересказывается
 * здесь — только режется.
 *
 * С прода t.me не читается (блок с нашей стороны, см. scout-relay), так что
 * такой источник живёт на реле вне РФ. Пока реле не настроено, он честно
 * отчитается отказом в `sources[]`, а не молчанием.
 */

import { htmlToText } from '@/lib/partners/prospect-parse';

export interface TelegramPost {
  /** Первая строка поста, обрезанная до TITLE_MAX. */
  title: string;
  /** Постоянная ссылка на пост: https://t.me/<канал>/<id>. */
  url: string;
  /** Подпись источника — как у RSS-лент. */
  source: string;
}

const TITLE_MAX = 140;
const POSTS_MAX = 5;

/** Адрес публичного превью канала по его имени. */
export function telegramPreviewUrl(channel: string): string {
  return `https://t.me/s/${channel.replace(/^@/, '')}`;
}

/** Ссылка-приглашение (`t.me/+…`, `joinchat`) — закрытый чат, превью нет. */
export function isTelegramInvite(url: string): boolean {
  return /t\.me\/(\+|joinchat\/)/i.test(url);
}

/**
 * Адрес превью канала по ссылке на ПОСТ: `t.me/<канал>/<id>` → `t.me/s/<канал>`.
 * null — ссылка не на пост канала (приглашение, корень, чужой хост).
 *
 * Нужен, потому что сама страница поста отдаёт HTML-обёртку виджета без
 * содержимого: 04.09 её сняли как «текст статьи», отдали модели, и та
 * ответила отказом «не вижу текста, пришли выдержки» — прямо в канал.
 */
export function telegramPreviewUrlForPost(postUrl: string): string | null {
  const m = /^https:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]+)\/\d+/.exec(postUrl);
  return m ? `https://t.me/s/${m[1]}` : null;
}

/**
 * Текст КОНКРЕТНОГО поста со страницы превью канала. Пустая строка — пост
 * на странице не найден (уехал за край выдачи) или в нём нет текста; это
 * честное «текста нет», а не обёртка виджета, выданная за содержимое.
 */
export function telegramPostText(html: string, postUrl: string): string {
  const id = /\/(\d+)(?:[?#]|$)/.exec(postUrl)?.[1];
  if (!id) return '';
  const blocks = html.split(/<div[^>]+class="[^"]*tgme_widget_message_wrap[^"]*"/i).slice(1);
  for (const block of blocks) {
    const href = /<a[^>]+class="[^"]*tgme_widget_message_date[^"]*"[^>]+href="(https:\/\/t\.me\/[^"]+)"/i.exec(block)?.[1] ?? '';
    const post = /data-post="([A-Za-z0-9_]+\/\d+)"/i.exec(block)?.[1] ?? '';
    if (!href.endsWith(`/${id}`) && !post.endsWith(`/${id}`)) continue;
    const textHtml = /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '';
    return htmlToText(textHtml.replace(/<br\s*\/?>/gi, '\n')).trim();
  }
  return '';
}

/**
 * Разбор превью в посты. Чистая функция: HTML на входе, посты на выходе.
 * Пост без текста или без постоянной ссылки — не сигнал (нечего показать
 * и некуда вести), он пропускается.
 */
export function parseTelegramPreview(html: string, source: string): TelegramPost[] {
  const posts: TelegramPost[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*tgme_widget_message_wrap[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*tgme_widget_message_date[^"]*"[^>]+href="(https:\/\/t\.me\/[^"]+)"/i.exec(block)?.[1]
      ?? /href="(https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+)"/i.exec(block)?.[1];
    const textHtml = /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '';
    const text = htmlToText(textHtml.replace(/<br\s*\/?>/gi, '\n'));
    const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
    if (!link || firstLine.length < 6) continue;
    const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
    posts.push({ title, url: link, source });
    if (posts.length >= POSTS_MAX) break;
  }
  return posts;
}
