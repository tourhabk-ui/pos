/**
 * lib/agents/scout-digest.ts
 *
 * Scout Digest — ежедневный разведывательный дайджест.
 * Запускается раз в сутки через /api/cron/scout-digest.
 *
 * Собирает сигналы из 4 областей:
 *   1. AI & Tech — что нового в AI для применения к платформе
 *   2. Travel Industry — новости туриндустрии РФ
 *   3. Референсы и рынок — передовые travel-tech продукты
 *   4. Камчатка — события региона; кормится НЕ из RSS, а из собственного
 *      safety-слоя (external_alerts: сейсмика КБГС, МЧС, дороги, пожары)
 *
 * Синтезирует через AI → отправляет дайджест в Telegram.
 * Хранит результат в agent_memory для истории.
 */

import { callAIFast, callAIQualityOrNull, fetchWithRetry } from '@/lib/ai/providers';
import { pool } from '@/lib/db-pool';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { deduplicateBySimilarity, jaccardFromTokens, jaccardSimilarity, tokenizeForSimilarity } from '@/lib/utils/text-similarity';
import { readAgentBriefing } from '@/lib/agents/warmup';
import { firecrawlScrape, firecrawlAvailable } from '@/lib/services/ingest/firecrawl';
import {
  SCOUT_SOURCE_EXPECTATIONS, applyRun, mapToRows, markAlertedInMap, buildSourceReport,
  evaluateDeadSources, dueForAlert, formatScoutDeadSources,
  type ScoutHealthMap, type ScoutSourceReport, type SourceHealthEntry, type SourceStatus,
} from '@/lib/services/scout/source-health';
import type { ChatMessage } from '@/lib/ai/prompts';
import { stripTags } from '@/lib/html/text';

/**
 * Причина пропуска человеческим языком — для алерта, а не для лога.
 *
 * Код `all_sections_empty` в Telegram владельцу означает ровно столько же,
 * сколько молчание: чтобы понять, нужно лезть в исходник. Словарь живёт РЯДОМ
 * с местами, где причины рождаются, и покрытие сторожит тест: добавили новую
 * причину — либо назвали её, либо сборка красная. Неизвестный код всё равно
 * показывается как есть — лучше сырой код, чем «неизвестно».
 */
export const SKIP_REASON_LABELS: Record<string, string> = {
  no_rss_items: 'ни один источник не дал свежих материалов',
  synthesis_null: 'модель не вернула синтез',
  all_sections_empty: 'после разбора все разделы оказались пусты',
  unsourced_percents: 'в тексте проценты без ссылки на источник',
  factcheck_judge_mute: 'проверяющая модель не ответила — выпуск придержан',
  // Четыре РАЗНЫЕ беды, которые до 18.08 сливались в одну строку выше.
  // Владелец видел «модель не ответила» семнадцать дней и искал причину в
  // блокировке провайдера — а из четырёх случаев это верно ровно в одном.
  judge_silent: 'проверяющая модель вернула пустоту — молчит провайдер',
  // 22.08: заглушка callAIFast («Сервис временно недоступен.») — непустой
  // текст без JSON, и судья звал это «прозой вместо JSON, сбой в промпте».
  // Владелец три недели читал совет чинить промпт при мёртвых провайдерах.
  judge_unavailable: 'не ответил ни один провайдер — чинить у провайдера, не в промпте',
  // Обрыв — не проза: модель отвечала верно и не поместилась в потолок.
  judge_truncated: 'ответ судьи оборвался на середине — не хватило потолка токенов',
  judge_unparseable: 'проверяющая модель ответила прозой вместо JSON — сбой в промпте, не в провайдере',
  judge_bad_shape: 'в ответе судьи нет поля unsupported — сбой в промпте, не в провайдере',
  judge_threw: 'запрос к проверяющей модели упал — сеть, ключ или таймаут',
  unsupported_claims: 'утверждения не подтверждены источниками',
  near_repeat: 'выпуск почти повторял предыдущий',
  telegram_send_failed: 'синтез готов, но Telegram не принял отправку',
  // ── Отдельный канал — отдельные причины ──────────────────────────────────
  // AI-пост живёт ВНУТРИ этого же прогона и после всех фактчек-гейтов. Любой
  // ранний выход обрывал функцию до него, а причина записывалась про основной
  // канал. Со стороны это выглядело как «дайджест ушёл» при молчащем AI-канале
  // (владелец 17.08: «нет публикаций в канале, хотя расписание делали»).
  ai_channel_not_configured: 'TELEGRAM_AI_CHANNEL_ID не задан — публиковать некуда',
  ai_no_items: 'ни один AI-источник не дал материалов',
  ai_synthesis_null: 'модель не вернула AI-пост',
  ai_unsourced_percents: 'в AI-посте проценты без ссылки на источник',
  ai_factcheck_failed: 'утверждения AI-поста не подтверждены статьями',
  ai_send_failed: 'AI-пост готов, но Telegram не принял отправку',
  ai_digest_aborted: 'прогон оборвался до AI-поста',
};

export interface DigestResult {
  signals_found: number;
  digest_sent: boolean;
  /**
   * Почему выпуск НЕ ушёл (немота 01-08.08: шесть выходов digest_sent:false
   * без причины — неделя тишины при зелёном кроне, вскрыто пробой).
   * synthesis_null | all_sections_empty | unsourced_percents |
   * factcheck_judge_mute | unsupported_claims | near_repeat | no_rss_items |
   * telegram_send_failed. Отсутствует — выпуск ушёл.
   */
  digest_skip_reason?: string;
  /**
   * Улика к причине: начало ответа, который не разобрался (22.08).
   *
   * Код `judge_unparseable` называет КЛАСС беды — «модель ответила не тем».
   * Чинить надо конкретное: преамбулу перед JSON, markdown-забор, обрыв на
   * середине или отказ отвечать. Без самой строки это гадание, а гадание уже
   * стоило трёх недель — алерт уверенно советовал чинить промпт при вопросе,
   * которого никто не видел. Не более 200 символов, только в ответ и журнал.
   */
  digest_skip_detail?: string;
  /**
   * Ушёл ли пост во ВТОРОЙ канал — AI-канал.
   *
   * До 17.08 этих двух полей не было, и результат отправки на строке 833
   * просто выбрасывался: `await tgSendRich(...)` без присваивания. Канал мог
   * молчать неделями при зелёном кроне и при `digest_sent: true` — потому что
   * дайджест и правда уходил, только в другое место.
   *
   * `undefined` — про канал ничего не известно (прогон не дошёл): это тоже
   * состояние, и оно отличается от «не отправили по такой-то причине».
   */
  ai_channel_sent?: boolean;
  /** Почему AI-пост НЕ ушёл. Коды с префиксом `ai_` в SKIP_REASON_LABELS. */
  ai_channel_skip_reason?: string;
  duration_ms: number;
  /** Здоровье источников за прогон: сколько живых из всех и какие молчат. */
  sources_ok?: number;
  sources_total?: number;
  dead_sources?: string[];
  /**
   * Пофидовая расшифровка того же прогона. Без неё «6 из 12» — это сигнал
   * тревоги без адреса: половина разведки молчит, а какая именно и по какой
   * причине (упал / отдал пусто) — неизвестно, и разбирать нечего.
   */
  sources?: ScoutSourceReport[];
  /** Сколько сигналов отсеяно как уже показанные (URL + похожий заголовок). */
  repeats_suppressed?: number;
  /** Выпуск почти дословно повторил предыдущий и был заблокирован перед отправкой. */
  repeat_blocked?: boolean;
}

interface RssItem {
  title: string;
  url: string;
  source: string;
}

type SourceCategory = 'ai' | 'travel' | 'kamchatka' | 'reference';

/** Экспортирован ради инвариант-теста: каждый фид обязан сторожиться. */
export const RSS_SOURCES: Array<{ key: string; url: string; label: string; category: SourceCategory }> = [
  // AI & Tech — фронтир (англоязычные практические источники для тех, кто строит с LLM/агентами)
  { key: 'simonwillison', url: 'https://simonwillison.net/atom/everything/', label: 'Simon Willison', category: 'ai' },
  { key: 'huggingface',   url: 'https://huggingface.co/blog/feed.xml',       label: 'Hugging Face',   category: 'ai' },
  { key: 'marktechpost',  url: 'https://www.marktechpost.com/feed/',         label: 'MarkTechPost',   category: 'ai' },
  { key: 'hackernews',    url: 'https://hnrss.org/newest?q=LLM+OR+agent+OR+Claude+OR+Cursor', label: 'Hacker News', category: 'ai' },
  // AI & Tech — русский слой
  { key: 'habr_ai',       url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', label: 'Habr AI', category: 'ai' },
  // Референсы и рынок — передовые travel-tech продукты и новинки, откуда берём
  // фичи/паттерны «сделать у себя». Раньше жили только в intelligence-monitor и
  // упирались в каналы — в эволюцию (evo_growth_issues) не доходили.
  { key: 'skift',         url: 'https://skift.com/feed/',            label: 'Skift',        category: 'reference' },
  { key: 'producthunt',   url: 'https://www.producthunt.com/feed',   label: 'Product Hunt', category: 'reference' },

  // Туриндустрия РФ — возвращение 08.08. Оба источника были сняты 01.08 как
  // мёртвые (сайты убили старые ленты), из-за чего раздел «Туриндустрия» жил
  // на одном международном Skift, а категория 'travel' не имела ни одного
  // источника. Издания пережили редизайн, фиды вернулись на НОВЫХ адресах —
  // найдены в HTML главных и проверены пробой с раннера (run 31239764170:
  // живой RSS 2.0 со свежими item). Раздел «Камчатка» кормится не отсюда,
  // а из собственного safety-слоя — см. SAFETY_LAYER_SOURCE ниже.
  { key: 'tourprom', url: 'https://www.tourprom.ru/feed/rss.xml', label: 'Турпром',   category: 'travel' },
  { key: 'ratanews', url: 'https://ratanews.ru/rss.xml',          label: 'RATA News', category: 'travel' },

  // ── УДАЛЕНЫ 01.08 как мёртвые (диагноз по полю error прогона 09:10 UTC) ──
  // Поле error (появилось в #916) дало точную причину, а не «молчит»:
  //   rata     — fetch failed: хост rata-news.ru не отвечает (DNS/блок/лёг);
  //   tourprom — HTTP 404: tourprom.ru/rss снят;
  //   ator     — HTTP 404: atorus.ru/rss/news.xml снят;
  //   kamgov   — HTTP 404: kamgov.ru/rss снят;
  //   mchs_rss — HTTP 404: 41.mchs.gov.ru/rss снят (гос-CMS ушла с RSS).
  // Все 4 «404» — это сами сайты сняли ленты, а не переехали: гадать новый
  // URL нечего, ленты нет. КАМЧАТСКИЕ safety-данные при этом НЕ потеряны —
  // МЧС и kamgov идут живым путём через safety-ingest (seismic-parser:
  // t.me / vk_mchs / max_mchs / kamgov-XML), независимо от этого RSS.
  // Замена travel-лент на живые — отдельным PR, когда подтвердится рабочий
  // URL из РФ (из песочницы домены отдают 403, проверить нельзя — не выдумываю).
];

/**
 * Safety-слой как источник раздела «Камчатка» (решение владельца 08.08:
 * «делай камчатку из safety-слоя»). Регион остался без RSS: kamgov снят 01.08
 * (ленты нет), а WAF режет даже раннеры. При этом собственный мониторинг —
 * сейсмика КБГС, МЧС (t.me/vk/max), kamgov-XML, пожары FIRMS — уже складывает
 * события в external_alerts. Дайджест читает СВОЮ БД, а не чужую ленту:
 * этот источник не может «снять RSS» или закрыться WAF'ом.
 */
export const SAFETY_LAYER_SOURCE = {
  key: 'safety_layer',
  label: 'Safety-слой',
  category: 'kamchatka' as SourceCategory,
};

/** Потолок сигналов safety-слоя за прогон — раздел, а не сводка МЧС целиком. */
const SAFETY_ALERTS_LIMIT = 8;

interface SafetyAlertRow {
  title: string | null;
  source_url: string | null;
}

/** Строки external_alerts → сигналы дайджеста (чистая, тестируется без БД). */
export function alertsToItems(rows: SafetyAlertRow[]): RssItem[] {
  const items: RssItem[] = [];
  for (const r of rows) {
    const title = (r.title ?? '').trim();
    if (title.length <= 5) continue;
    items.push({ title, url: r.source_url ?? '', source: SAFETY_LAYER_SOURCE.label });
  }
  return items;
}

/**
 * Свежие события безопасности региона за сутки. Пустой день — честный 'empty'
 * (на Камчатке тихо), ошибка БД — 'error': отчёт здоровья различает их так же,
 * как у RSS-фидов. Окно 25 часов — как у объектива прод-ошибок: суточный крон
 * с точным окном в 24ч терял бы события на стыке запусков.
 */
async function fetchSafetyLayerSource(): Promise<SourceFetch> {
  const s = SAFETY_LAYER_SOURCE;
  try {
    const { rows } = await pool.query<SafetyAlertRow>(
      `SELECT title, source_url
         FROM external_alerts
        WHERE created_at > NOW() - INTERVAL '25 hours'
        ORDER BY severity DESC NULLS LAST, created_at DESC
        LIMIT $1`,
      [SAFETY_ALERTS_LIMIT],
    );
    const items = alertsToItems(rows);
    return { key: s.key, label: s.label, category: s.category, items, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (e) {
    return { key: s.key, label: s.label, category: s.category, items: [], status: 'error', error: ((e as Error).message || 'unknown').slice(0, 160) };
  }
}

// Метки AI-источников — для отдельного поста в @ai_hub_money
const AI_LABELS = new Set(RSS_SOURCES.filter(s => s.category === 'ai').map(s => s.label));

// Все источники разведки для метаданных выпуска: RSS плюс safety-слой.
const ALL_SOURCE_LABELS = [...RSS_SOURCES.map(s => s.label), SAFETY_LAYER_SOURCE.label];

// Метка источника → категория. Нужна, чтобы тянуть текст статей по разделам
// (см. комментарий у ARTICLE_TEXT_PER_CATEGORY) — у самого RssItem категории нет.
const CATEGORY_BY_LABEL = new Map<string, SourceCategory>([
  ...RSS_SOURCES.map(s => [s.label, s.category] as const),
  [SAFETY_LAYER_SOURCE.label, SAFETY_LAYER_SOURCE.category],
]);

// Общий ретрай-хелпер с backoff+jitter (Roitman §18.7.1) — переиспользуем
// вместо локальной реализации без jitter, которая ретраила ЛЮБую ошибку
// (включая собственный таймаут); теперь таймаут фида не ретраится (это
// не транзиентный сбой, а исчерпанный бюджет времени на медленный источник).
async function fetchRssWithRetry(url: string, options: RequestInit, label: string): Promise<Response> {
  return fetchWithRetry(url, options, { timeoutMs: 8000, maxRetries: 2, baseDelayMs: 1000, label: `rss:${label}` });
}

/** Разбор RSS/Atom в items (чистая, без сети). */
function parseRssItems(xml: string, label: string): RssItem[] {
  const items: RssItem[] = [];
  // RSS использует <item>, Atom (напр. Simon Willison) — <entry>. Поддерживаем оба.
  const blockRegex = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRegex.exec(xml)) !== null && items.length < 5) {
    const block = match[2];
    const title = (
      /<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)
        ?.slice(1).find(Boolean) ?? ''
    ).trim();
    // RSS: <link>URL</link> | Atom: <link href="URL"/> | fallback: <guid>
    const link = (
      /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1]      // Atom
      ?? /<link[^>]*>(https?[^<]+)<\/link>/i.exec(block)?.[1]   // RSS
      ?? /<guid[^>]*>(https?[^<]+)<\/guid>/i.exec(block)?.[1]   // fallback
      ?? ''
    ).trim();
    if (title && title.length > 5) {
      items.push({ title, url: link, source: label });
    }
  }
  return items;
}

interface SourceFetch {
  key: string;
  label: string;
  category: SourceCategory;
  items: RssItem[];
  /** Честный исход: 'ok' (фид отдал items), 'empty' (0 items), 'error' (упал/не-200). */
  status: SourceStatus;
  /** Причина сбоя — только при 'error': HTTP-код или текст исключения. */
  error?: string;
}

/**
 * Тянет один источник и КЛАССИФИЦИРУЕТ исход — чтобы «нет сигналов» перестало
 * быть немым: видно, фид отдал материал, отдал пусто или упал. Раньше упавший
 * фид молча давал [] и был неотличим от «сегодня тихо».
 */
async function fetchSource(s: { key: string; url: string; label: string; category: SourceCategory }): Promise<SourceFetch> {
  try {
    const res = await fetchRssWithRetry(s.url, {
      headers: { 'User-Agent': 'TourHab/1.0 (Scout Digest)' },
    }, s.label);
    if (!res.ok) {
      return { key: s.key, label: s.label, category: s.category, items: [], status: 'error', error: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const items = parseRssItems(xml, s.label);
    return { key: s.key, label: s.label, category: s.category, items, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (e) {
    return { key: s.key, label: s.label, category: s.category, items: [], status: 'error', error: ((e as Error).message || 'unknown').slice(0, 160) };
  }
}

async function tgSendTo(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    return (data as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function tgSendRich(
  chatId: string,
  text: string,
  buttons?: Array<Array<{ text: string; url: string }>>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };
    if (buttons?.length) body.reply_markup = { inline_keyboard: buttons };
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return (data as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function tgSend(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;
  return tgSendTo(chatId, text);
}

/** `u` — ключ (URL), `t` — когда увидели, `h` — заголовок на момент показа. */
export interface SeenEntry { u: string; t: number; h?: string }
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Окно сравнения по заголовку — 7 суток, а не 30 как у URL.
 * Одна и та же история на этой неделе — повтор; она же через три недели —
 * почти всегда развитие сюжета (было «отключили инструмент», стало «выписали
 * штраф»), и глушить его нельзя. Короткое окно бьёт по перепечаткам, длинное
 * било бы по новостям.
 */
const SEEN_TITLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 0.5 — тот же агрессивный порог, что и для дедупа внутри прогона. */
const REPEAT_TITLE_THRESHOLD = 0.5;

/**
 * Отсев уже показанного. URL-сравнения мало: та же история назавтра приходит
 * другой ссылкой (другое издание, тот же материал с обновлённым линком) и
 * проходит как свежая — так 28.07 в дайджест второй раз попал сюжет про
 * антимонопольное дело Trip.com. Заголовок переживает смену ссылки, поэтому
 * сравниваем ещё и по нему — тем же Jaccard, которым дедупим внутри прогона.
 *
 * Чистая функция: тестируется без сети и памяти агента.
 */
export function filterUnseen<T extends { title: string; url: string }>(
  items: T[],
  entries: SeenEntry[],
  now: number,
): { fresh: T[]; repeatsByUrl: number; repeatsByTitle: number } {
  const seenUrls = new Set(entries.map(e => e.u));
  const seenTitles = entries
    .filter(e => e.h && now - e.t < SEEN_TITLE_WINDOW_MS)
    .map(e => tokenizeForSimilarity(e.h as string));

  const fresh: T[] = [];
  let repeatsByUrl = 0;
  let repeatsByTitle = 0;

  for (const item of items) {
    const key = item.url || item.title;
    if (!key) continue;
    if (seenUrls.has(key)) { repeatsByUrl++; continue; }

    const tokens = tokenizeForSimilarity(item.title);
    const isRepeat = tokens.size > 0
      && seenTitles.some(t => jaccardFromTokens(t, tokens) >= REPEAT_TITLE_THRESHOLD);
    if (isRepeat) { repeatsByTitle++; continue; }

    fresh.push(item);
  }

  return { fresh, repeatsByUrl, repeatsByTitle };
}

/**
 * Память о том, что КАНАЛ уже видел, — недостающий третий эшелон отсева.
 *
 * filterUnseen режет повторные СИГНАЛЫ (URL за 30 суток, заголовок Jaccard≥0.5
 * за 7), но перепечатка другими словами делит с оригиналом 2-3 токена из
 * десяти и проходит как свежая. Дальше синтез: в промпте написано «не
 * дублировать уже выданные инсайты», а recentRuns из warmup.ts содержит только
 * метаданные («07:00 — success, обработано: 12») — ни слова из вчерашнего
 * выпуска. Модель физически не может не повторить то, чего не видела; при этом
 * каждый выпуск ХРАНИТСЯ в agent_knowledge (intel/scout/<дата>) и до сих пор
 * не показывался. Та же болезнь write-only, что была у уроков эволюции.
 */

/** Сколько последних выпусков подаётся модели. */
export const PUBLISHED_DIGESTS_LIMIT = 2;
/** Потолок блока «уже опубликовано» в символах промпта. */
export const PUBLISHED_BLOCK_MAX_CHARS = 3500;
/**
 * Порог «выпуск повторяет предыдущий». Заголовки разделов дайджеста общие
 * (~10 токенов), поэтому два честных выпуска о разных новостях дают ~0.15-0.3;
 * 0.6 достигается только когда повторена большая часть содержимого. Порог
 * сознательно консервативный: недоблокировать лучше, чем съесть живой выпуск.
 */
export const REPEAT_DIGEST_THRESHOLD = 0.6;

/** Тексты последних выпусков из agent_knowledge, новые первыми. Ошибка БД → []. */
export async function recentPublishedDigests(limit = PUBLISHED_DIGESTS_LIMIT): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ compiled_truth: string }>(
      `SELECT compiled_truth
         FROM agent_knowledge
        WHERE agent_id = 'scout' AND type = 'intel' AND slug LIKE 'intel/scout/%'
        ORDER BY slug DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.compiled_truth).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Блок «уже опубликовано» для промпта синтеза. Чистая функция: пусто на входе —
 * пустая строка (не занимаем контекст заглушкой). Это ДАННЫЕ на каждом прогоне,
 * а не разрастание шаблона: инструкция одна, содержимое приносит БД.
 */
export function publishedDigestsBlock(texts: string[], maxChars = PUBLISHED_BLOCK_MAX_CHARS): string {
  const nonEmpty = texts.map((t) => t.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return '';
  const block =
    `=== УЖЕ ОПУБЛИКОВАНО В КАНАЛЕ (последние выпуски) ===\n` +
    `НЕ пересказывай эти сюжеты, даже если сегодня они пришли из другого источника другими словами. ` +
    `Повтор допустим только при РАЗВИТИИ сюжета — новом факте, которого нет в выпусках ниже.\n\n` +
    nonEmpty.join('\n\n--- (предыдущий выпуск) ---\n\n');
  return block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
}

/**
 * Детерминированный предохранитель на выходе: выпуск, почти дословно
 * повторяющий один из предыдущих, в канал не уходит. Промпт-эшелон выше —
 * вероятностный (модель может ослушаться); этот — нет.
 */
export function isNearRepeatOfPrevious(
  digest: string,
  previous: string[],
  threshold = REPEAT_DIGEST_THRESHOLD,
): boolean {
  return previous.some((p) => p.trim() && jaccardSimilarity(digest, p) >= threshold);
}

// Фактчек-гейты переехали в lib/agents/fact-check.ts — они нужны ВСЕМ
// публикаторам в каналы (инцидент 31.07: пост intelligence-monitor с
// перенесёнными числами ушёл в AI-канал мимо гейтов, живших только здесь).
// Re-export — обратная совместимость импортов и сторожей.
export { unsourcedPercents } from '@/lib/agents/fact-check';
import { unsourcedPercents, unsupportedClaims, judgeClaims, type JudgeFailure } from '@/lib/agents/fact-check';

/**
 * Тянет текст статьи для фактчека: Firecrawl (если ключ) → обычный fetch + грубое
 * извлечение текста из HTML. Возвращает '' при неудаче (тогда модель опирается на заголовок).
 */
async function fetchArticleText(url: string): Promise<string> {
  if (!url) return '';
  if (firecrawlAvailable()) {
    try {
      const page = await firecrawlScrape(url);
      if (page?.markdown) return page.markdown.slice(0, 2500);
    } catch { /* fallthrough */ }
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TourHab/1.0 Scout)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    // Снятие тегов — общее (lib/html/text). Сущности здесь гасятся ОПТОМ,
    // а не разворачиваются: разведчику нужен текст для выжимки, не разметка.
    return stripTags(html, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);
  } catch { return ''; }
}

// unsupportedClaims — тоже из общего модуля (см. комментарий у re-export выше).

/** Причина отказа судьи → код пропуска. Слова живут в SKIP_REASON_LABELS. */
function judgeSkipReason(why: JudgeFailure): string {
  return `judge_${why}`;
}

/**
 * Учитывает здоровье источников за прогон, персистит в agent_memory и алертит
 * про молчащие фиды (дебаунс). Переиспользует детерминированный evaluateDeadSources
 * из safety. Не критично для дайджеста — ошибки глотаем.
 */
async function recordSourceHealthAndAlert(
  fetched: SourceFetch[],
): Promise<{ sources_ok: number; sources_total: number; dead_sources: string[]; sources: ScoutSourceReport[] }> {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const entries: Array<SourceHealthEntry & { category: SourceCategory }> = fetched.map(f => ({
    key: f.key, label: f.label, category: f.category, status: f.status, rawItems: f.items.length, inserted: 0,
    ...(f.error ? { error: f.error } : {}),
  }));

  let deadLabels: string[] = [];
  // Память может быть недоступна — тогда отчёт строим по одному этому прогону:
  // статус и число items честны и без истории, теряется только «молчит N часов».
  let map: ScoutHealthMap = applyRun({}, entries, nowIso);
  try {
    const stored = await agentMemory.recall('scout-digest', 'source_health', 1).catch(() => []);
    const prevMap = ((stored[0]?.value as { map?: ScoutHealthMap } | undefined)?.map) ?? {};
    map = applyRun(prevMap, entries, nowIso);

    const rows = mapToRows(map);
    const dead = evaluateDeadSources(rows, SCOUT_SOURCE_EXPECTATIONS, nowMs);
    deadLabels = dead.map(d => d.label);

    const toAlert = dueForAlert(dead, rows, nowMs);
    if (toAlert.length > 0) {
      await tgSend(formatScoutDeadSources(toAlert));
      map = markAlertedInMap(map, toAlert.map(d => d.key), nowIso);
    }

    await agentMemory.remember({
      agent_id: 'scout-digest',
      memory_type: 'source_health',
      key: 'sources',
      value: { map } as unknown as Record<string, unknown>,
      source: 'scout_digest_cron',
      expires_at: new Date(nowMs + 90 * 24 * 60 * 60 * 1000),
    });
  } catch {
    // health — вспомогательное, не роняем дайджест
  }

  return {
    sources_ok: entries.filter(e => e.status === 'ok').length,
    sources_total: entries.length,
    dead_sources: deadLabels,
    sources: buildSourceReport(entries, map, nowMs),
  };
}

export async function runScoutDigest(): Promise<DigestResult> {
  const start = Date.now();

  // Warm-up: read platform state and own run history before doing any work.
  // recentRuns tells the agent what it already processed so it avoids duplicates.
  const briefing = await readAgentBriefing('scout-digest');

  // Последние выпуски канала: модели — чтобы не пересказывала, предохранителю
  // перед отправкой — чтобы почти дословный повтор не ушёл подписчикам.
  const publishedDigests = await recentPublishedDigests();

  // Collect signals in parallel — RSS плюс safety-слой, с честным статусом каждого
  const fetched = await Promise.all([...RSS_SOURCES.map(fetchSource), fetchSafetyLayerSource()]);
  const allItems: RssItem[] = [];
  for (const f of fetched) allItems.push(...f.items);

  // Здоровье источников: делает «нет сигналов» диагностируемым (живой фид без
  // новостей vs мёртвый фид) и алертит про молчащие. До любых ранних выходов.
  const health = await recordSourceHealthAndAlert(fetched);

  if (allItems.length === 0) {
    return { signals_found: 0, digest_sent: false, digest_skip_reason: 'no_rss_items', duration_ms: Date.now() - start, ...health };
  }

  // Cross-run dedup: URL за 30 суток + заголовок за 7 (см. filterUnseen)
  const now = Date.now();
  const seenRaw = await agentMemory.recall('scout-digest', 'seen_urls', 1);
  const storedEntries: SeenEntry[] = (seenRaw[0]?.value as { urls?: SeenEntry[] } | undefined)?.urls ?? [];
  const activeEntries = storedEntries.filter(e => now - e.t < THIRTY_DAYS_MS);

  const { fresh: freshItems, repeatsByUrl, repeatsByTitle } = filterUnseen(allItems, activeEntries, now);
  // Число видно в ответе крона: если фильтр начнёт съедать живые новости,
  // это станет заметно по цифре, а не по ощущению «дайджест обмельчал».
  const repeats_suppressed = repeatsByUrl + repeatsByTitle;

  if (freshItems.length === 0) {
    const sent = await tgSend(
      `<b>Дайджест ${new Date().toLocaleDateString('ru-RU')}</b>\n\nНовых сигналов за сутки нет. Мониторинг продолжается.`,
    );
    return { signals_found: 0, digest_sent: sent, ...(sent ? {} : { digest_skip_reason: 'telegram_send_failed' }), duration_ms: Date.now() - start, ...health, repeats_suppressed };
  }

  // Дедупликация: одна история из нескольких источников → одна запись
  const dedupedItems = deduplicateBySimilarity(freshItems, i => i.title, 0.5);

  /**
   * Текст статьи для ограниченного числа сигналов на раздел (24.08, причина
   * молчания с 01.08). Раньше и писателю, и фактчек-судье доставался ОДИН
   * голый заголовок на сигнал. AI-канал ниже давно тянет текст статьи именно
   * потому, что «у модели только заголовки» — прямая цитата из его же
   * комментария. Основной дайджест этого не делал: писателя просили выделить
   * 3-5 инсайтов (синтез по определению), а судья (JUDGE_SYSTEM в fact-check.ts)
   * помечает как «неподтверждённое» любую связку и следствие, которых нет
   * ДОСЛОВНО в источнике. На одних заголовках синтез почти всегда такую
   * связку добавляет — отсюда unsupported_claims каждый прогон подряд.
   *
   * По 4 сигнала на раздел (а не по всем) — бюджет символов у судьи не
   * бесконечный (см. sources.slice в fact-check.ts, поднят вместе с этой
   * правкой). Safety-слой Камчатки без url — fetchArticleText вернёт '' и
   * останется голым заголовком; это верно и раньше: факт уже наш собственный,
   * подтверждать его статьёй не у чего.
   *
   * Поднято с 2 до 4 (29.08) — после первой правки молчание продолжалось
   * (17-26.08 подряд): двух текстов на раздел мало, когда сигналов в разделе
   * больше — оставшиеся голые заголовки писатель всё равно тянет в общий
   * инсайт раздела, и судья снова видит связку без текстового подтверждения.
   * 4×700 символов на раздел из 4 разделов — 11200 символов худшего случая,
   * запас до лимита судьи (16000) остаётся.
   */
  const ARTICLE_TEXT_PER_CATEGORY = 4;
  const perCategoryPicks = new Map<SourceCategory, RssItem[]>();
  for (const item of dedupedItems) {
    const cat = CATEGORY_BY_LABEL.get(item.source);
    if (!cat) continue;
    const picks = perCategoryPicks.get(cat) ?? [];
    if (picks.length < ARTICLE_TEXT_PER_CATEGORY) {
      picks.push(item);
      perCategoryPicks.set(cat, picks);
    }
  }
  const toEnrich = [...perCategoryPicks.values()].flat();
  const textByItem = new Map<RssItem, string>();
  await Promise.all(toEnrich.map(async item => {
    const text = await fetchArticleText(item.url);
    if (text) textByItem.set(item, text);
  }));

  // AI synthesis
  const signalsList = dedupedItems
    .map(i => {
      const text = textByItem.get(i);
      return text ? `[${i.source}] ${i.title}\nТЕКСТ: ${text.slice(0, 700)}` : `[${i.source}] ${i.title}`;
    })
    .join('\n');

  // Build context section from briefing so AI knows current state and prior runs.
  // recentRuns — только метаданные запусков; тексты уже выданных выпусков
  // подаёт publishedDigestsBlock, без него «не дублировать» не на что опереться.
  const contextSection = [
    briefing.platformSummary ? `=== ТЕКУЩЕЕ СОСТОЯНИЕ ПЛАТФОРМЫ ===\n${briefing.platformSummary}` : '',
    briefing.recentRuns ? `=== МОИ ПОСЛЕДНИЕ ЗАПУСКИ ===\n${briefing.recentRuns}` : '',
    publishedDigestsBlock(publishedDigests),
  ].filter(Boolean).join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты разведчик туристической платформы TourHab (Камчатка).
Твоя задача — прочитать сигналы из RSS-лент и выделить 3-5 наиболее важных инсайтов.

ПРАВИЛА ВКЛЮЧЕНИЯ (широкие — лучше включить лишнее, чем потерять нужное):
- Раздел "AI & Tech" — любые новые модели, инструменты, агенты, обновления Claude/GPT/Gemini/Cursor, автоматизация, веб-разработка. Мы активно используем AI в разработке — даже косвенно полезное включай.
- Раздел "Туриндустрия" — туризм в РФ и мире, онлайн-бронирование, OTA, CRM для туроператоров, новые тренды. Другие регионы — допустимы как контекст или аналогия.
- Раздел "Референсы и рынок" — передовые travel-tech продукты и новинки (Skift, Product Hunt): конкретные фичи/паттерны, которые можно перенять на нашу платформу (планировщик, бронирование, ИИ-помощник, офлайн, карты). Пиши, ЧТО именно сделали и что из этого нам стоит рассмотреть.
- Раздел "Камчатка" — ЛЮБЫЕ новости о Камчатском крае: туризм, экология, транспорт, инфраструктура, погода, безопасность. Мы обслуживаем туристов на Камчатке — любой контекст о регионе ценен. Сигналы с пометкой [Safety-слой] — события из нашего собственного мониторинга безопасности региона (сейсмика, вулканы, дороги, пожары): излагай сам факт из заголовка, это и есть новость региона.
- "Нет значимых сигналов за сегодня" — ТОЛЬКО если в разделе буквально ноль материалов. Если есть хоть что-то — пиши.

НЕ ВРАТЬ. Пиши только то, что есть в сигналах:
- Цифры, цены, версии, названия фич и технический механизм — ДОСЛОВНО из сигнала. Нет в сигнале — не пиши.
- Особенно про цены и тарифы: "без изменения цены", "дешевле", "бесплатно" — только если это сказано в сигнале. Не выводи из общих соображений.
- Если известен только заголовок — пиши общо, что появилось, без выдуманной конкретики.
- Не объединяй РАЗНЫЕ сигналы в один вывод, тренд или причинность, если этого
  нет дословно ни в одном источнике (даже без цифр — судья считает выдумкой
  саму связку). Для сигналов с пометкой ТЕКСТ — можно опираться на её
  содержание; для сигналов без ТЕКСТ (только заголовок) — один заголовок,
  один отдельный факт, без параллелей с другими пунктами раздела.
- Лучше скромный честный пункт, чем эффектный с выдумкой. Выдуманный факт = провал.

Связь с платформой добавляй, ТОЛЬКО если она настоящая и конкретная.
Натянутая привязка ("может быть полезно для рекомендаций в туризме") хуже её
отсутствия: она ничего не сообщает и обесценивает остальной текст. Нет связи —
просто скажи, что произошло.

Пустых обещаний не давать: "стоит следить за обновлениями", "может изменить
рынок" — это не инсайт. Либо конкретика из сигнала, либо пункт не нужен.

Формат ответа — только HTML для Telegram, без markdown:
<b>Дайджест [дата]</b>

<b>AI & Tech</b>
- [что произошло, конкретика из сигнала]

<b>Туриндустрия</b>
- [краткий инсайт]

<b>Референсы и рынок</b>
- [какую фичу/паттерн внедрил передовой продукт и что нам стоит рассмотреть]

<b>Камчатка</b>
- [краткий инсайт про Камчатский край]

Пиши по-русски. Кратко и по делу. Без воды.`,
    },
    {
      role: 'user',
      content: `${contextSection ? contextSection + '\n\n' : ''}Сигналы за ${new Date().toLocaleDateString('ru-RU')}:\n\n${signalsList}`,
    },
  ];

  /**
   * Синтез через ЧЕСТНЫЙ к отказу вызов (22.08).
   *
   * `callAIQuality` при отказе всех провайдеров возвращает не пустоту, а
   * строку-заглушку. Она непустая, поэтому проверка `synthesis_null` её
   * пропускала, и прогон шёл дальше — с «дайджестом», в котором написано
   * «сервис недоступен». Дальше его судил фактгейт и, разумеется, заворачивал.
   * Улика была на виду: у всех 21 несостоявшегося прогона `llm_calls: 1`
   * против 2-7 у состоявшихся — ответ не пришёл ни один.
   *
   * `callAIQualityOrNull` отдаёт то же самое честным `null`. Заглушка,
   * принятая за текст, — третье место того же дефекта за день (были судья
   * фактгейта и диагноз в алерте).
   */
  let digest: string | null = null;
  try {
    digest = await callAIQualityOrNull(messages, { maxTokens: 1600 });
  } catch {
    digest = null;
  }

  if (!digest) {
    return { signals_found: freshItems.length, digest_sent: false, digest_skip_reason: 'synthesis_null', duration_ms: Date.now() - start, ...health, repeats_suppressed };
  }

  // Все разделы пусты — НЕ публикуем. Раньше здесь всё равно шёл tgSend, и в
  // канал уходил дайджест из трёх строк «Нет значимых сигналов за сегодня».
  // Сообщение «сегодня новостей нет» не стоит публикации: оно ничего не несёт
  // и приучает пролистывать. seen_urls тоже не трогаем — вернёмся завтра.
  // Порог = число разделов дайджеста (AI, Туриндустрия, Референсы, Камчатка).
  // Иначе, добавив раздел, мы бы глушили дайджест, где пусты 3 из 4 — а в
  // четвёртом (напр. «Референсы») есть настоящий сигнал.
  const allEmpty = (digest.match(/Нет значимых сигналов за сегодня/g) ?? []).length >= 4;
  if (allEmpty) {
    return { signals_found: 0, digest_sent: false, digest_skip_reason: 'all_sections_empty', duration_ms: Date.now() - start, ...health, repeats_suppressed };
  }

  // ── Фактчек основного дайджеста ────────────────────────────────────────────
  // Те же два гейта, что давно стоят на посте в AI-канал. Здесь их не было — и
  // 25.07.2026 в дайджест ушло «Claude Opus 5 — без изменения цены», хотя цена
  // изменилась вдвое. Модель не врала злонамеренно: ей просто не запретили
  // додумывать, и никто не сверял результат с источником.
  {
    let bad = unsourcedPercents(digest, signalsList);
    if (bad.length > 0) {
      const fix: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: digest },
        { role: 'user', content: `В тексте есть проценты, которых НЕТ в сигналах: ${bad.join(', ')}. Перепиши дайджест, убрав все неподтверждённые числа (формулируй без них). Верни только исправленный текст.` },
      ];
      const retry = await callAIQualityOrNull(fix, { maxTokens: 1600 }).catch(() => null);
      if (retry) { digest = retry; bad = unsourcedPercents(digest, signalsList); }
    }
    if (bad.length > 0) {
      return { signals_found: freshItems.length, digest_sent: false, digest_skip_reason: 'unsourced_percents', duration_ms: Date.now() - start, ...health, repeats_suppressed };
    }

    // Судья отвечает ПРИЧИНОЙ отказа, а не просто отказом: «молчит провайдер»
    // и «ответила прозой вместо JSON» чинятся в разных местах, и одно слово на
    // оба отправляет чинить не туда.
    const verdict = await judgeClaims(digest, signalsList);
    if (!verdict.ok) {
      return {
        signals_found: freshItems.length, digest_sent: false,
        digest_skip_reason: judgeSkipReason(verdict.why),
        ...(verdict.sample ? { digest_skip_detail: verdict.sample } : {}),
        duration_ms: Date.now() - start, ...health, repeats_suppressed,
      };
    }
    let claims: string[] | null = verdict.unsupported;
    // До двух попыток исправления (29.08, было одна): одна попытка часто
    // убирала часть выдуманных связок, но не все — судья возвращал новый
    // непустой список, и прогон уходил в unsupported_claims, хотя текст стал
    // ближе к источникам. Вторая попытка получает СВЕЖИЙ список от судьи по
    // ПЕРЕПИСАННОМУ тексту, не повторяет старые претензии.
    for (let attempt = 0; attempt < 2 && claims !== null && claims.length > 0; attempt++) {
      const fix: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: digest },
        { role: 'user', content: `Эти утверждения НЕ подтверждаются сигналами (выдумка, искажение или связка между разными сигналами, которой нет в тексте): ${claims.join(' | ')}. Перепиши дайджест строго по источникам: убери связки и выводы, для которых нет дословного текста, не добавляй новых непроверенных фактов. Верни только исправленный текст.` },
      ];
      const retry = await callAIQualityOrNull(fix, { maxTokens: 1600 }).catch(() => null);
      if (!retry) break;
      digest = retry;
      claims = await unsupportedClaims(digest, signalsList);
    }
    if (claims === null || claims.length > 0) {
      // Лучше не выпустить дайджест, чем выпустить с выдумкой (или непроверенным).
      return { signals_found: freshItems.length, digest_sent: false, digest_skip_reason: claims === null ? 'factcheck_judge_mute' : 'unsupported_claims', duration_ms: Date.now() - start, ...health, repeats_suppressed };
    }
  }

  // Предохранитель повторов: выпуск, почти дословно совпадающий с уже
  // опубликованным, в канал не уходит. Сигналы seen НЕ помечаем — они честно
  // свежие и завтра пойдут в новый синтез; провалился именно текст выпуска.
  if (isNearRepeatOfPrevious(digest, publishedDigests)) {
    return {
      signals_found: freshItems.length, digest_sent: false, repeat_blocked: true, digest_skip_reason: 'near_repeat',
      duration_ms: Date.now() - start, ...health, repeats_suppressed,
    };
  }

  // Mark URLs as seen AFTER successful AI synthesis (don't mark if AI failed)
  const updatedEntries: SeenEntry[] = [
    ...activeEntries,
    // h — заголовок: он переживает смену ссылки и ловит перепечатку завтра.
    ...freshItems.map(i => ({ u: i.url || i.title, t: now, h: i.title })),
  ].slice(-1000);
  await agentMemory.remember({
    agent_id: 'scout-digest',
    memory_type: 'seen_urls',
    key: 'url_set',
    value: { urls: updatedEntries } as unknown as Record<string, unknown>,
    source: 'scout_digest_cron',
    expires_at: new Date(now + 60 * 24 * 60 * 60 * 1000), // renew 60d; internal filter handles 30d per-entry
  });

  const sent = await tgSend(digest);

  // Post AI & Tech section only to the AI channel (@ai_hub_money — vibe-coding, 40K subs)
  //
  // Исход публикации во второй канал считается ЯВНО и уезжает в результат
  // прогона. Раньше он выбрасывался: `await tgSendRich(...)` без присваивания,
  // ни одного поля про этот канал в DigestResult, ни одной причины в
  // SKIP_REASON_LABELS. Канал мог молчать неделями при зелёном кроне — и это
  // ровно то, что произошло.
  let aiSent = false;
  let aiSkip: string | undefined = 'ai_digest_aborted';
  const aiChannelId = process.env.TELEGRAM_AI_CHANNEL_ID;
  if (!aiChannelId) {
    aiSkip = 'ai_channel_not_configured';
  } else {
    const aiItems = dedupedItems.filter(i => AI_LABELS.has(i.source));
    if (aiItems.length === 0) {
      aiSkip = 'ai_no_items';
    } else {
      const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      // Тянем текст статей (фон, cron) — чтобы модель опиралась на содержание, а не на заголовок
      const aiTop = aiItems.slice(0, 3);
      const withText = await Promise.all(
        aiTop.map(async i => ({ ...i, text: await fetchArticleText(i.url) })),
      );
      const aiSignals = withText
        .map(i => `[${i.source}] ${i.title}\nURL: ${i.url}\nТЕКСТ СТАТЬИ:\n${i.text || '(текст недоступен — опирайся ТОЛЬКО на заголовок, без выдуманных деталей)'}`)
        .join('\n\n---\n\n');
      const aiMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `Ты практикующий AI-инженер и редактор Telegram-канала о вайб-кодинге (40К подписчиков).
Читатели САМИ строят с LLM и агентами: Claude Code, Cursor, LangGraph, MCP, локальные модели. Им нужен сигнал «что попробовать сегодня» и почему это меняет их работу.

ГЛАВНОЕ ПРАВИЛО — НЕ ВРАТЬ. Тебе даны выдержки статей. Опирайся ТОЛЬКО на них:
- Цифры, проценты, версии, названия фич, технический механизм бери ДОСЛОВНО из текста статьи. Нет в тексте — не пиши.
- НЕ переноси цифру с одного инструмента на другой. НЕ обобщай чужие бенчмарки.
- Если у материала текст недоступен (только заголовок) — пиши общо «что появилось и зачем», без выдуманной конкретики.
- Лучше скромный честный пост, чем эффектный с выдумкой. Выдуманный факт = провал.

Из материалов выбери 2-3 САМЫХ СИЛЬНЫХ. Вводное и вторичное — выбрасывай.

Для каждого:
- что появилось (по тексту статьи, дословная конкретика)
- <b>Почему важно:</b> практический takeaway (это твоя оценка-вывод, она допустима; факты-цифры — только из статьи)

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ — только Telegram HTML:

<b>AI-дайджест · ${today}</b>

<b>[Цепляющий заголовок — суть в 5-8 слов]</b>
[2 предложения: что сделали, конкретика — версии/цифры/инструмент]
<b>Почему важно:</b> [1-2 предложения: практический вывод для строителя агентов]
<a href="URL">Читать →</a>

<b>[Второй заголовок]</b>
[2 предложения конкретики]
<b>Почему важно:</b> [практический вывод]
<a href="URL">Читать →</a>

<blockquote expandable>[Необязательный третий материал или глубокий нюанс — что меняется в практике]</blockquote>

ПРАВИЛА:
- <a href="URL"> только если URL реально был в сигнале
- Без буллитов (•) и нумерации, без «интересно/важно отметить»
- Технический, уверенный тон. Как пишет инженер инженерам, а не SMM
- Пиши по-русски (даже если источник английский — синтезируй русский инсайт)`,
        },
        {
          role: 'user',
          content: `Сигналы:\n\n${aiSignals}`,
        },
      ];
      let aiDigest = await callAIQualityOrNull(aiMessages, { maxTokens: 1600 }).catch(() => null);
      if (!aiDigest) aiSkip = 'ai_synthesis_null';

      // ── Фактчек-гейт: проценты в посте должны быть в исходных заголовках ──
      // У модели только заголовки, поэтому любой процент, которого нет в источнике, — выдумка.
      if (aiDigest) {
        let bad = unsourcedPercents(aiDigest, aiSignals);
        if (bad.length > 0) {
          // одна попытка переписать без неподтверждённых цифр
          const fix: ChatMessage[] = [
            ...aiMessages,
            { role: 'assistant', content: aiDigest },
            { role: 'user', content: `В тексте есть проценты, которых НЕТ в исходных заголовках: ${bad.join(', ')}. Это запрещено. Перепиши пост, полностью убрав все цифры и проценты, не подтверждённые заголовками (формулируй без чисел). Верни только исправленный пост.` },
          ];
          const retry = await callAIQualityOrNull(fix, { maxTokens: 1600 }).catch(() => null);
          if (retry) { aiDigest = retry; bad = unsourcedPercents(aiDigest, aiSignals); }
        }
        if (bad.length > 0) {
          // Числовой фактчек не пройден — НЕ публикуем (лучше не запостить, чем соврать).
          aiDigest = null;
          aiSkip = 'ai_unsourced_percents';
        }
      }

      // ── Семантический фактчек: сверяем факты поста с текстом статей ──
      if (aiDigest) {
        let claims = await unsupportedClaims(aiDigest, aiSignals);
        // null — судья не ответил: не публикуем (сбой гейта = отмена).
        if (claims === null) {
          aiDigest = null;
          aiSkip = 'ai_factcheck_failed';
        } else if (claims.length > 0) {
          const fix: ChatMessage[] = [
            ...aiMessages,
            { role: 'assistant', content: aiDigest },
            { role: 'user', content: `Эти утверждения НЕ подтверждаются текстом статей (выдумка или искажение): ${claims.join(' | ')}. Перепиши пост, убрав или исправив их строго по источникам. Не добавляй новых непроверенных фактов. Верни только исправленный пост.` },
          ];
          const retry = await callAIQualityOrNull(fix, { maxTokens: 1600 }).catch(() => null);
          if (retry) { aiDigest = retry; claims = await unsupportedClaims(aiDigest, aiSignals); }
          // После переписи: остаток выдумок ИЛИ повторный сбой судьи — не публикуем.
          if (claims === null || claims.length > 0) { aiDigest = null; aiSkip = 'ai_factcheck_failed'; }
        }
      }

      if (aiDigest) {
        const buttons = aiItems
          .filter(i => i.url)
          .slice(0, 3)
          .map(i => [{ text: i.title.slice(0, 45) + (i.title.length > 45 ? '…' : ''), url: i.url }]);
        aiSent = await tgSendRich(aiChannelId, aiDigest, buttons.length > 0 ? buttons : undefined);
        aiSkip = aiSent ? undefined : 'ai_send_failed';
      }
    }
  }

  // Store permanently in knowledge brain
  try {
    const dateKey = new Date().toISOString().slice(0, 10);
    const slug = `intel/scout/${dateKey}`;
    await knowledgeBase.upsert({
      slug,
      type: 'intel',
      title: `Scout Digest ${dateKey}`,
      compiled_truth: digest,
      metadata: {
        signals: dedupedItems.length, raw_signals: allItems.length, fresh_signals: freshItems.length,
        sources: ALL_SOURCE_LABELS,
        // Честный per-source статус: какой фид отдал материал, а какой молчит/упал.
        // Тот же отчёт, что уезжает в ответ крона — чтобы история и разбор по
        // горячим следам показывали одно и то же, а не две похожие таблицы.
        source_health: health.sources,
        dead_sources: health.dead_sources,
        sent_to_tg: sent,
        // Второй канал — в том же артефакте. Health читает именно артефакт, и
        // без этих полей он видел бы «дайджест свежий» при канале, молчащем
        // неделю: свежесть основного выпуска ничего не говорит о втором.
        ai_channel_sent: aiSent,
        ai_channel_skip_reason: aiSkip ?? null,
      },
      agent_id: 'scout',
    });
    // Also keep short-term memory for agents that scan recent intel
    await agentMemory.remember({
      agent_id: 'evo',
      memory_type: 'intelligence',
      key: `scout_digest_${dateKey}`,
      value: { slug, signals: freshItems.length, sources: ALL_SOURCE_LABELS },
      confidence: 0.8,
      source: 'scout_digest_cron',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });
  } catch {
    // Non-critical
  }

  return {
    signals_found: dedupedItems.length,
    digest_sent: sent,
    ...(sent ? {} : { digest_skip_reason: 'telegram_send_failed' }),
    // Второй канал отчитывается отдельно: дайджест мог уйти, а AI-пост — нет,
    // и наоборот. Одно поле на два канала скрывало ровно этот случай.
    ai_channel_sent: aiSent,
    ...(aiSkip ? { ai_channel_skip_reason: aiSkip } : {}),
    duration_ms: Date.now() - start,
    ...health,
    repeats_suppressed,
  };
}
