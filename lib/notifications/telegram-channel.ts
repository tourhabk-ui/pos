/**
 * Posting to Telegram channel (TELEGRAM_CHANNEL_ID)
 *
 * Используется для двух типов постов:
 *   А — контент: новые маршруты и операторы (маркетинг)
 *   Б — уведомления: новые лиды и брони (в TELEGRAM_CHAT_ID, admin-группа)
 */

import { query } from '@/lib/database';
import { callAIWithModelDirect, callAIQuality } from '@/lib/ai/providers';
import { getModelForAgent } from '@/lib/ai/agent-models';
import { validateRoutePost, validateTextPost, logValidationFailure, blockingTextIssue, promisesRouteOrTrack, advisesLeavingTrail } from '@/lib/notifications/post-validation';
import { unsourcedPercents, unsupportedClaims } from '@/lib/agents/fact-check';
import { stripTags } from '@/lib/html/text';
import { absolutePhotoUrls } from '@/lib/notifications/photo-urls';
import { composePlacePost } from '@/lib/notifications/place-post';

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * fetch к api.telegram.org с retry + экспоненциальным backoff.
 * Timeweb (РФ) периодически режет egress до Telegram → "fetch failed".
 * Повторяем сетевые сбои (fetch throw) до 3 раз: 1s, 2s, 4s.
 * HTTP-ответ Telegram (даже с ошибкой типа "chat not found") НЕ повторяем —
 * это не сетевая проблема, ретрай не поможет.
 */
async function tgFetchWithRetry(
  url: string,
  body: Record<string, unknown>,
  maxAttempts = 3,
): Promise<{ ok: boolean; description?: string }> {
  let lastErr = 'fetch error';
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      // Получили HTTP-ответ — возвращаем как есть, не ретраим логические ошибки
      return await res.json() as { ok: boolean; description?: string };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'fetch error';
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  return { ok: false, description: `${lastErr} (после ${maxAttempts} попыток)` };
}

async function tgPost(chatId: string, text: string, botToken?: string): Promise<{ ok: boolean; error?: string }> {
  const token = botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, error: 'not configured' };
  const data = await tgFetchWithRetry(
    `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false },
  );
  return { ok: data.ok, error: data.description };
}

/** Одна попытка sendPhoto — БЕЗ фолбэка. Причина отказа возвращается наверх. */
async function tgSendPhotoOnce(chatId: string, photoUrl: string, caption: string, token: string): Promise<{ ok: boolean; error?: string }> {
  const data = await tgFetchWithRetry(
    `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendPhoto`,
    {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption.slice(0, 1024),
      parse_mode: 'HTML',
    },
  );
  return { ok: data.ok, error: data.description };
}

/** Фиксирует пропажу картинки у поста — раньше фолбэк был молчаливым, и посты
 * уходили текстом без единого следа причины (кейс владельца «Гремучие ключи»
 * 27.07: фото было выбрано, но в канал ушёл голый текст). */
function logPhotoFallback(photoUrl: string, error: string | undefined, outcome: 'fallback_photo' | 'text_only'): void {
  console.error(`[tgPostPhoto] sendPhoto отказал (${outcome}):`, error ?? 'unknown', '| photo:', photoUrl);
  query(
    `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
    ['channel_photo_fallback', JSON.stringify({ photo_url: photoUrl, error: error ?? 'unknown', outcome })],
  ).catch(() => { /* лог не должен ронять пост */ });
}

/**
 * Альбом фотографий одним постом (sendMediaGroup, до 10 штук).
 *
 * Зачем отдельно от tgPostPhoto: у тура есть настоящие снимки оператора, и
 * показывать один — значит продавать хуже, чем есть. Подпись Telegram берёт с
 * ПЕРВОГО элемента группы, остальным её давать нельзя — пост развалится.
 *
 * Деградация честная и по шагам: не ушёл альбом — пробуем одиночное фото
 * (у него свой фолбэк в текст), не ушло и оно — остаётся текст. Пустой список
 * фотографий сюда не передаём: это не «пост без картинок», а ошибка вызова.
 */
export async function tgPostMediaGroup(
  chatId: string,
  photoUrls: string[],
  caption: string,
  botToken?: string,
): Promise<{ ok: boolean; error?: string; sent: number; fellBackToSingle?: boolean }> {
  const token = botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, error: 'not configured', sent: 0 };
  if (photoUrls.length === 0) return { ok: false, error: 'нет фотографий', sent: 0 };

  const photos = photoUrls.slice(0, 10);
  if (photos.length > 1) {
    const media = photos.map((url, i) => (
      i === 0
        ? { type: 'photo', media: url, caption: caption.slice(0, 1024), parse_mode: 'HTML' }
        : { type: 'photo', media: url }
    ));
    const data = await tgFetchWithRetry(
      `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMediaGroup`,
      { chat_id: chatId, media },
    );
    if (data.ok) return { ok: true, sent: photos.length };
    console.error('[tgPostMediaGroup] альбом не ушёл:', data.description ?? 'unknown');
    query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      ['channel_media_group_fallback', JSON.stringify({ count: photos.length, error: data.description ?? 'unknown' })],
    ).catch(() => { /* лог не должен ронять пост */ });
  }

  const single = await tgPostPhoto(chatId, photos[0], caption, token);
  return { ...single, sent: single.ok ? 1 : 0, fellBackToSingle: photos.length > 1 };
}

// sendPhoto — caption до 1024 символов. Экспорт — для ручных постов
// (lib/notifications/manual-channel-post.ts), не только для генераторов ниже.
// fallbackPhotoUrl — вторая попытка (куратор-фото), если основное фото
// Telegram скачать не смог (>5 МБ, таймаут, 5xx нашего эндпоинта). Текст —
// последний рубеж, и теперь каждый откат логируется с причиной.
export async function tgPostPhoto(
  chatId: string,
  photoUrl: string,
  caption: string,
  botToken?: string,
  fallbackPhotoUrl?: string | null,
): Promise<{ ok: boolean; error?: string; fellBackToText?: boolean }> {
  const token = botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, error: 'not configured' };

  const first = await tgSendPhotoOnce(chatId, photoUrl, caption, token);
  if (first.ok) return { ok: true };

  if (fallbackPhotoUrl && fallbackPhotoUrl !== photoUrl) {
    logPhotoFallback(photoUrl, first.error, 'fallback_photo');
    const second = await tgSendPhotoOnce(chatId, fallbackPhotoUrl, caption, token);
    if (second.ok) return { ok: true };
    logPhotoFallback(fallbackPhotoUrl, second.error, 'text_only');
  } else {
    logPhotoFallback(photoUrl, first.error, 'text_only');
  }

  const textResult = await tgPost(chatId, caption, token);
  return { ...textResult, fellBackToText: true };
}

/** Отправка в MAX канал через MAX Platform API.
 * Экспорт — для ручных постов (manual-channel-post.ts), не только для
 * автоматических публикаторов через postToAllChannels. */
/**
 * Отказ MAX — это запись, а не строчка в логе контейнера.
 *
 * Владелец 06.08: «MAX канал не публикует новости». Проверить это было
 * нечем: все зеркала в MAX — fire-and-forget с console.error, который
 * уходит в лог Timeweb и не читается никем. Сколько постов не дошло и
 * почему — неизвестно в принципе. Теперь каждый отказ ложится в
 * ai_actions_log (max_post_failed) с причиной — его видно из админки и
 * может подхватить Watchdog.
 */
async function recordMaxFailure(error: string, text: string): Promise<void> {
  console.error('[maxChannelPost]', error);
  try {
    await query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      ['max_post_failed', JSON.stringify({ error: error.slice(0, 300), text_preview: text.slice(0, 120) })],
    );
  } catch { /* лог недоступен — хотя бы console остался */ }
}

export async function maxChannelPost(
  text: string,
  photoUrl?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.MAX_BOT_TOKEN;
  const channelId = process.env.MAX_CHANNEL_ID;
  if (!token || !channelId) {
    const error = `не настроен env: ${!token ? 'MAX_BOT_TOKEN ' : ''}${!channelId ? 'MAX_CHANNEL_ID' : ''}`.trim();
    await recordMaxFailure(error, text);
    return { ok: false, error };
  }

  const attachments: Array<Record<string, unknown>> = [];
  if (photoUrl) {
    attachments.push({ type: 'image', payload: { url: photoUrl } });
  }

  try {
    const body: Record<string, unknown> = {
      text,
      format: 'html',
      notify: true,
    };
    if (attachments.length > 0) body.attachments = attachments;

    const res = await fetch(
      // MAX Bot API v2 host — старый platform-api.max.ru выведен из эксплуатации.
      `https://platform-api2.max.ru/messages?chat_id=${channelId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
        },
        body: JSON.stringify(body),
      },
    );
    // Тело читаем текстом: при отказе MAX может отдать не-JSON, и «Unexpected
    // end of JSON input» скрыл бы настоящий ответ (тот же урок, что с
    // сохранением тура 05.08).
    const raw = await res.text();
    let data: { message?: Record<string, unknown>; code?: string; description?: string } = {};
    try { data = JSON.parse(raw); } catch { /* оставляем пустым, ниже покажем raw */ }
    if (data.message) return { ok: true };
    const error = data.description ?? data.code
      ?? `HTTP ${res.status}: ${raw.replace(/\s+/g, ' ').slice(0, 200) || 'пустой ответ'}`;
    await recordMaxFailure(error, text);
    return { ok: false, error };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'MAX fetch error';
    await recordMaxFailure(error, text);
    return { ok: false, error };
  }
}

/**
 * Публикация в основной TG-канал + MAX канал с кросс-ссылками.
 *
 * Здесь же — последний рубеж перед подписчиками. Валидация постов
 * (post-validation.ts) существует давно, и её шапка требует «каждый пост ОБЯЗАН
 * пройти валидацию», но звать её должен был каждый публикатор сам. 25.07.2026
 * один не позвал, и в канал ушёл пост «Сервис временно недоступен.» — заглушка,
 * которую waterfall возвращает СТРОКОЙ при отказе всех провайдеров.
 *
 * Обязанность, которую легко забыть, рано или поздно забывают. Все восемь
 * публикаторов идут через эту функцию, поэтому проверка стоит тут: дешёвая,
 * синхронная, без сети — и обойти её, не тронув эту строку, нельзя.
 */
/**
 * Единственный путь автоматической публикации в оба канала — и единственное
 * место, где текст проверяется целиком.
 *
 * `postType` нужен не для красоты: без него отказ ложится в журнал безымянным,
 * и «пост не вышел» нельзя связать с публикатором.
 *
 * Про двойную проверку. Пост о маршруте проходит `validateRoutePost` до
 * вызова, и текстовая часть проверится дважды — лишние HEAD-запросы на
 * несколько постов в сутки. Это дешевле, чем восемь публикаторов, каждый со
 * своим решением, проверяться ему или нет: ровно так после инцидента 12.07
 * проверку получил один вид постов из девяти.
 */
interface ChannelPost {
  /** id основного Telegram-канала */
  channelId: string;
  /** Кто публикует: `route`, `kuzmich_tip`, `safety`… — попадает в журнал отказа */
  postType: string;
  text: string;
  photoUrl?: string | null;
  /** Куратор-фото: уходит, если Telegram не смог скачать основное */
  fallbackPhotoUrl?: string | null;
  /**
   * Альбом НАСТОЯЩИХ фотографий (2–10): sendMediaGroup, подпись на первой.
   * Для постов о турах — у тура снимки оператора, и показывать один — значит
   * продавать хуже, чем есть (та же логика, что у tgPostMediaGroup). Когда
   * задан, photoUrl игнорируется; в MAX уходит первый кадр альбома.
   */
  photoUrls?: string[] | null;
}

async function postToAllChannels(post: ChannelPost): Promise<{ ok: boolean; error?: string }> {
  const { channelId: mainChannelId, postType, text, photoUrl, fallbackPhotoUrl, photoUrls } = post;
  const issue = blockingTextIssue(text);
  if (issue) {
    const error = `Публикация отменена: ${issue}`;
    console.error('[postToAllChannels]', error, `| текст: ${JSON.stringify(text.slice(0, 120))}`);
    return { ok: false, error };
  }

  // Полная проверка текста: качество, запрещённое и ЖИВОСТЬ ВСЕХ ССЫЛОК.
  // 12.07.2026 канал опубликовал ссылку на мёртвую страницу — валидатор для
  // этого существовал и был подключён только к постам о маршрутах.
  const validation = await validateTextPost(text);
  for (const w of validation.warnings) {
    console.error('[postToAllChannels] предупреждение:', postType, w);
  }
  if (!validation.valid) {
    const error = `Публикация отменена: ${validation.errors.join('; ')}`;
    console.error('[postToAllChannels]', postType, error);
    await logValidationFailure(postType, validation);
    return { ok: false, error };
  }

  const tgLink = process.env.TELEGRAM_CHANNEL_LINK ?? '';
  const maxLink = process.env.MAX_CHANNEL_LINK ?? '';

  // Текст для TG → добавляем ссылку на MAX
  const tgText = maxLink
    ? text + `\n\n<a href="${maxLink}">Мы в MAX</a>`
    : text;

  // Текст для MAX → добавляем ссылку на TG
  const maxText = tgLink
    ? text + `\n\n<a href="${tgLink}">Мы в Telegram</a>`
    : text;

  // 1. Основной TG-канал. Альбом настоящих фото (photoUrls) — приоритетный
  // путь: sendMediaGroup со своей честной деградацией (альбом → одно фото →
  // текст, каждый шаг логируется). Иначе прежнее: фото → куратор-фото → текст.
  const mainResult = photoUrls && photoUrls.length > 0
    ? await tgPostMediaGroup(mainChannelId, photoUrls, tgText)
    : photoUrl
      ? await tgPostPhoto(mainChannelId, photoUrl, tgText, undefined, fallbackPhotoUrl)
      : await tgPost(mainChannelId, tgText);

  // 2. MAX канал (fire-and-forget); альбом MAX не умеет — уходит первый кадр
  maxChannelPost(maxText, photoUrls?.[0] ?? photoUrl).then(r => {
    if (!r.ok) console.error('[postToAllChannels] MAX channel error:', r.error);
  }).catch(() => {});

  return mainResult;
}

const LOCATION_LABELS: Record<string, string> = {
  volcano:    'Вулкан',
  geyser:     'Гейзеры',
  hot_spring: 'Термальные источники',
  lake:       'Озеро',
  mountain:   'Горы',
  river:      'Река',
  bay:        'Морское побережье',
  waterfall:  'Водопад',
  cape:       'Мыс',
  island:     'Остров',
  rock:       'Скалы',
  forest:     'Лес',
  beach:      'Пляж',
  viewpoint:  'Смотровая',
  settlement: 'Населённый пункт',
  other:      'Природный объект',
};

const ACTIVITY_LABELS: Record<string, string> = {
  trekking:   'Треккинг',
  fishing:    'Рыбалка',
  thermal:    'Термальный отдых',
  volcano:    'Восхождение на вулкан',
  helicopter: 'Вертолётная экскурсия',
  boat_trip:  'Морская прогулка',
  snowmobile: 'Снегоходы',
  skiing:     'Лыжи / скитур',
  diving:     'Дайвинг',
  kayak:      'Байдарки',
  horseback:  'Конный маршрут',
  birdwatching: 'Орнитология',
  photography: 'Фотоохота',
  other:      'Активный отдых',
};

// ── А. Контентные посты ───────────────────────────────────────────────────────

interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  location_type: string | null;
  activity_type: string | null;
  price_from: number | null;
  duration_days: number | null;
}

/**
 * Постит маршрут в канал.
 * @param photoUrl — необязательно, если задан — пост с фото (sendPhoto)
 */
export async function postRouteToChannel(routeId: string, photoUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const res = await query<RouteRow>(
    `SELECT id, title, description, location_type, activity_type,
            (payload->>'price_from')::numeric AS price_from,
            (payload->>'duration_days')::numeric AS duration_days
     FROM agent_route_knowledge
     WHERE id = $1 AND is_visible = TRUE`,
    [routeId]
  );
  const r = res.rows[0];
  if (!r) return { ok: false, error: 'Route not found or not visible' };

  const locLabel   = LOCATION_LABELS[r.location_type ?? ''] ?? r.location_type ?? '';
  const actLabel   = ACTIVITY_LABELS[r.activity_type ?? ''] ?? r.activity_type ?? '';
  const desc = r.description ? r.description.slice(0, 200).trimEnd() + (r.description.length > 200 ? '…' : '') : '';
  const appUrl = getPublicBaseUrl();

  const lines: string[] = [];
  lines.push(`🌋 <b>${esc(r.title)}</b>`);
  lines.push('');
  if (desc) lines.push(esc(desc));
  lines.push('');

  const tags: string[] = [];
  if (locLabel)  tags.push(`📍 ${esc(locLabel)}`);
  if (actLabel)  tags.push(`🥾 ${esc(actLabel)}`);
  if (tags.length) lines.push(tags.join('  ·  '));

  const meta: string[] = [];
  if (r.duration_days) meta.push(`${r.duration_days} дн.`);
  if (r.price_from)    meta.push(`от ${r.price_from.toLocaleString('ru-RU')} ₽`);
  if (meta.length) lines.push(`💰 ${meta.join('  ·  ')}`);

  lines.push('');
  lines.push(`<a href="${appUrl}/routes/${r.id}">Смотреть маршрут →</a>`);

  const text = lines.join('\n');
  return postToAllChannels({ channelId, postType: 'route', text, photoUrl });
}

interface PartnerRow {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  location: string | null;
  hero_image: string | null;
}

/**
 * Постит оператора (партнёра) в канал.
 * Автоматически берёт hero_image из БД если photoUrl не передан.
 */
export async function postOperatorToChannel(slug: string, photoUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const res = await query<PartnerRow>(
    `SELECT id, name, description, slug, location->>'city' AS location, hero_image
     FROM partners
     WHERE slug = $1 AND is_public = TRUE`,
    [slug]
  );
  const p = res.rows[0];
  if (!p) return { ok: false, error: 'Operator not found or not public' };

  const desc = p.description ? p.description.slice(0, 250).trimEnd() + (p.description.length > 250 ? '…' : '') : '';
  const appUrl = getPublicBaseUrl();

  const lines: string[] = [];
  lines.push(`🏔 <b>${esc(p.name)}</b> — партнёр TourHab`);
  lines.push('');
  if (desc) lines.push(esc(desc));
  if (p.location) lines.push(`\n📍 ${esc(p.location)}`);
  lines.push('');
  lines.push(`<a href="${appUrl}/operators/${p.slug}">Профиль оператора →</a>`);

  const text = lines.join('\n');
  const photo = photoUrl ?? p.hero_image ?? undefined;
  return postToAllChannels({ channelId, postType: 'operator', text, photoUrl: photo });
}

/**
 * Голос Кузьмича — ОДИН на все канальные промпты (слово владельца 21.08:
 * «нынешние» посты съехали в SMM — «Зимний телепорт», буллеты «почему
 * круто», 17 хэштегов, «мы с Кузьмичом»). Принципы, не перечень кейсов
 * (CLAUDE.md §8); хэштег-простыни и эмодзи-обвес дополнительно режет
 * детерминированный guard в post-validation (blockingTextIssue) — промпт
 * не гвард, модель его нарушает.
 *
 * Второй перекос — 24.08, владелец показал посты «сейчас»: маятник от SMM
 * качнулся в сухую пустоту. Запреты выше свою работу сделали, но одних
 * запретов мало — без позитивного ориентира модель, которой нельзя ни
 * хэштегов, ни буллитов, ни «мы с Кузьмичом», заполняет пост общими словами
 * настроения («не для тех, кто в кроссовках», «красоту не принесут на
 * тарелке») вместо содержания. Голос ниже добавляет ЧТО писать, не только
 * что нельзя — и отдельно снимает панибратство («братва») и подколы над
 * туристами, которые были в более старых постах ДО этой правки.
 */
export const KUZMICH_CHANNEL_VOICE = `Голос (обязательно):
- Ты сам Кузьмич и сам автор текста: пиши от первого лица. Никогда не пиши о
  Кузьмиче как о другом человеке («мы с Кузьмичом», «Кузьмич одобряет»);
  назвать себя в третьем лице можно только в шутку и редко
- Тон — тёплый и с достоинством, БЕЗ панибратства: никаких «братва», «народ»,
  разговорной фамильярности. Ты местный, который уважает читателя, а не
  свой в доску кореш
- Не подшучивай и не иронизируй над туристами и их незнанием — это не повод
  для смеха, это тот, для кого ты пишешь
- Дай читателю увидеть и почувствовать: конкретный образ — рельеф, звук, свет,
  запах, ощущение от места. Оценочное слово без картинки за ним («красиво»,
  «впечатляет») — не текст, а его отсутствие; лучше одна точная деталь, чем
  три эпитета
- Без хэштегов. Эмодзи — максимум один-два, только если правда к месту
- Без рекламных конструкций и буллет-списков «почему это круто»: ты местный,
  который знает, а не канал, который продаёт
- Числа (координаты, температуры, расстояния, время, цены) — только из
  переданных данных; чего в данных нет, о том числом не пиши`;

/**
 * AI генерирует сезонный пост в голосе Кузьмича и публикует в канал.
 */
export async function postSezonToChannel(): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const month = new Date().toLocaleString('ru-RU', { month: 'long' });

  const prompt = `Ты — Кузьмич, камчадал в третьем поколении. Напиши короткий пост для Telegram-канала о Камчатке.
Тема: что интересного можно сделать на Камчатке в ${month}.
Требования:
- 80-120 слов
- живой голос местного, не рекламный
- конкретные активности для этого месяца
- заканчивай ссылкой: vedarai.ru/routes
- HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
${KUZMICH_CHANNEL_VOICE}`;

  const text = await callAIWithModelDirect([
    { role: 'user', content: prompt },
  ], getModelForAgent('kuzmich'));

  return postToAllChannels({ channelId, postType: 'sezon', text });
}

// ── Справочник «Друзья» — внешние партнёры без страницы на сайте ─────────────

interface FriendEntry {
  name: string;
  tagline: string;
  contact: string;
  tg?: string;
  context: string;  // контекст для AI
}

const FRIENDS: Record<string, FriendEntry> = {
  soulful: {
    name: 'SoulfulKamchatka',
    tagline: 'Один день — три места. На джипе. По бездорожью.',
    contact: '+7 929 901-97-87 (WA)',
    tg: '@soulfulKamchatka',
    context: 'Джип-туры по Камчатке. Группы до 4 человек. За один день объезжают несколько труднодоступных мест. Работают круглый год. Неформальный подход, без лишних слов.',
  },
  mestechko: {
    name: 'Местечко Камчатка',
    tagline: 'Вертолёты, джипы, рыбалка. Всё серьёзно.',
    contact: '+7 914 998-19-80',
    tg: '@mestechkokam',
    context: 'Туроператор из Петропавловска-Камчатского. Вертолётные экскурсии в Долину гейзеров и на Курильское. Джип-туры по бездорожью. Морские прогулки. Снегоходы. Хели-ски. Рыбалка. Работают с 2010-х. Сайт mestechkokam.ru.',
  },
};

/**
 * Телефон подставляется ПОСЛЕ модели, а не отдаётся ей.
 *
 * Две причины, и обе весомее формальности. Первая: контакт живого человека в
 * тексте промпта — трансграничная передача персональных данных, потому что
 * промпт уходит зарубежному провайдеру (152-ФЗ, гард D1). Найдено 04.09
 * расширенным сканером: прежний шаблон видел `.phone` и `.email`, но не видел
 * `.contact`, и эта строка полтора месяца ездила в OpenRouter незамеченной.
 *
 * Вторая причина практическая и, пожалуй, важнее: модели ПЕРЕВИРАЮТ ЦИФРЫ.
 * Неверный телефон в публичном посте про друга хуже, чем отсутствие поста:
 * человек звонит не туда, а мы этого даже не узнаем. Подстановка на нашей
 * стороне делает ошибку невозможной по построению.
 *
 * Модель не поставила метку — дописываем строку сами: пост без контактов
 * бесполезен, а второй заход к модели стоил бы дороже и мог бы снова прийти
 * без метки.
 */
export const CONTACT_PLACEHOLDER = 'КОНТАКТЫ_ЗДЕСЬ';

export function withFriendContacts(text: string, friend: { contact: string; tg?: string }): string {
  const line = friend.tg ? `${friend.contact}, ${friend.tg}` : friend.contact;
  if (text.includes(CONTACT_PLACEHOLDER)) {
    return text.split(CONTACT_PLACEHOLDER).join(line);
  }
  return `${text.trimEnd()}\n\n${line}`;
}

/**
 * AI генерирует пост в голосе Кузьмича про внешнего партнёра («друга»)
 * и публикует в канал.
 */
export async function postFriendToChannel(slug: string): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const friend = FRIENDS[slug];
  if (!friend) {
    const available = Object.keys(FRIENDS).join(', ');
    return { ok: false, error: `Друг «${slug}» не найден. Доступные: ${available}` };
  }

  const prompt = `Ты — Кузьмич, камчадал в третьем поколении. Пишешь пост для Telegram-канала.
Тема: рекомендуешь своих друзей — ${friend.name}.
Контекст: ${friend.context}

Требования:
- 60-100 слов, живой голос местного жителя, без рекламного пафоса
- Немного иронии над городскими туристами которые сидят в гостиницах
- Конкретно и по делу — что они делают, чем отличаются
- Последней строкой поставь ровно ${CONTACT_PLACEHOLDER} и больше ничего к ней не добавляй
- HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
- Начни не с имени, а с наблюдения или ситуации
${KUZMICH_CHANNEL_VOICE}`;

  const generated = await callAIWithModelDirect([
    { role: 'user', content: prompt },
  ], getModelForAgent('kuzmich'));

  const text = withFriendContacts(generated, friend);

  return postToAllChannels({ channelId, postType: 'friend', text });
}

// ── А2. Кузьмич — AI-пост о конкретном маршруте (автономный cron) ────────────

interface KuzmichRouteRow {
  id: string;
  title: string;
  description: string | null;
  location_type: string | null;
  activity_type: string | null;
  has_track: boolean;
}

function publicAppUrl(): string {
  return getPublicBaseUrl();
}

/**
 * Свой снимок места — единственное фото, с которым пост может выйти.
 *
 * До 05.09 здесь стоял каскад: свой снимок → куратор-фото Камчатки по типу
 * локации с оговоркой «на фото не это место» → карта. Владелец снял пост про
 * озеро Зелёное вместе с таким фото: оговорка честна, но читатель видит
 * снимок над текстом и делает единственный вывод. Чужого снимка у поста о
 * месте больше нет — место без своего фото не выбирается вовсе (условие в
 * SQL ниже), а откат при отказе Telegram идёт в текст, не в чужую картинку.
 * Свои снимки — только wikimedia и ручная загрузка, не AI-блобы.
 */
export const OWN_PHOTO_MODELS = ['wikimedia', 'manual-upload'] as const;

function ownPhotoUrl(routeId: string): string {
  return `${publicAppUrl()}/api/images/route/${routeId}`;
}

/**
 * Выбирает случайное место со СВОИМ фото, не постившееся последние 30 дней,
 * собирает пост из его данных (composePlacePost — модели нет) и публикует.
 * Логирует в ai_actions_log.
 *
 * Решение владельца 05.09 после поста про озеро Зелёное: модель сочинила
 * кратер, железо и тёплую воду, которых нет в данных, а фото было чужим.
 * Промпт запрещал выдумывать — и не помог, как не помог 12.07 и 19.08.
 * Сторож структурный: тексту неоткуда взять то, чего нет в записи.
 */
export async function postKuzmichRoute(): Promise<{ ok: boolean; routeId?: string; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  // Пост ОБЯЗАН пройти validateRoutePost (12.07: канал опубликовал ссылку на
  // мёртвую страницу — валидатор существовал, но не был подключён). Невалидный
  // кандидат логируется и заменяется следующим, до 3 попыток.
  const rejectedIds: string[] = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    // Берём маршрут, который не постили последние 30 дней. Приоритет — местам
    // с реальным GPS-треком: пост «Гора Красная поляна» вёл на карточку без
    // маршрута («место есть, трека нет» — владелец, 12.07), обещание в тексте
    // не совпадало с содержимым страницы
    const pickResult = await query<KuzmichRouteRow>(`
      SELECT ark.id, ark.title, ark.description, ark.location_type, ark.activity_type,
             EXISTS (
               SELECT 1 FROM kamchatka_routes k
               WHERE k.geometry IS NOT NULL
                 AND (COALESCE(k.ark_id, k.id) = ark.id
                      OR k.metadata->>'place_ark_id' = ark.id::text)
             ) AS has_track
      FROM agent_route_knowledge ark
      WHERE ark.is_visible = TRUE
        AND ark.id::text <> ALL($1)
        AND EXISTS (
          SELECT 1 FROM ai_route_images i
          WHERE i.route_id = ark.id AND i.model = ANY($2)
        )
        AND ark.id::text NOT IN (
          SELECT metadata->>'route_id'
          FROM ai_actions_log
          WHERE action_type = 'kuzmich_post'
            AND created_at > NOW() - INTERVAL '30 days'
            AND metadata->>'route_id' IS NOT NULL
        )
      ORDER BY EXISTS (
               SELECT 1 FROM kamchatka_routes k
               WHERE k.geometry IS NOT NULL
                 AND (COALESCE(k.ark_id, k.id) = ark.id
                      OR k.metadata->>'place_ark_id' = ark.id::text)
             ) DESC, RANDOM()
      LIMIT 1
    `, [rejectedIds, [...OWN_PHOTO_MODELS]]);

    if (!pickResult.rows[0]) return { ok: false, error: 'Нет мест для поста: со своим фото и не опубликованных за 30 дней не осталось' };
    const r = pickResult.rows[0];

    const locLabel = LOCATION_LABELS[r.location_type ?? ''] ?? r.location_type ?? '';
    const actLabel = ACTIVITY_LABELS[r.activity_type ?? ''] ?? r.activity_type ?? '';
    const appUrl   = getPublicBaseUrl();

    // Текст — из записи, без модели. null — описания нет; такой кандидат
    // отбраковывается ниже тем же путём, что и любой другой.
    const text = composePlacePost(
      { id: r.id, title: r.title, description: r.description, has_track: r.has_track },
      { appUrl, locLabel, actLabel },
    ) ?? '';

    // Проверки результата остаются и без модели: описание в базе — тоже текст,
    // который кто-то написал, и совет уйти с тропы в нём так же недопустим, а
    // упоминание маршрута у места без трека так же обещает лишнее (12.07,
    // 19.08). Судим результат, а не источник.
    const leavesTrail = advisesLeavingTrail(text);
    if (leavesTrail || (!r.has_track && promisesRouteOrTrack(text))) {
      rejectedIds.push(r.id);
      try {
        await query(
          `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
          ['kuzmich_post_rejected', JSON.stringify({
            route_id: r.id, route_title: r.title,
            errors: [leavesTrail
              ? 'пост советует уходить с тропы'
              : 'пост обещает маршрут или трек, а у карточки трека нет'],
          })],
        );
      } catch { /* не блокируем перевыбор */ }
      continue;
    }

    const validation = await validateRoutePost(r.id, text);
    if (!validation.valid) {
      rejectedIds.push(r.id);
      try {
        await query(
          `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
          ['kuzmich_post_rejected', JSON.stringify({ route_id: r.id, route_title: r.title, errors: validation.errors })]
        );
      } catch { /* не блокируем перевыбор */ }
      continue;
    }

    // Свой снимок — он есть по условию выбора. Фолбэка на чужое фото нет:
    // если Telegram не смог скачать наш кадр, пост уходит текстом с логом
    // (tgPostPhoto), а не с картинкой другого места.
    const result = await postToAllChannels({
      channelId,
      postType: 'kuzmich_route',
      text,
      photoUrl: ownPhotoUrl(r.id),
      fallbackPhotoUrl: null,
    });

    if (result.ok) {
      try {
        await query(
          `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
          ['kuzmich_post', JSON.stringify({ route_id: r.id, route_title: r.title })]
        );
      } catch { /* таблица ещё не создана — не блокируем пост */ }
    }

    return { ...result, routeId: r.id };
  }

  return { ok: false, error: `Все кандидаты не прошли валидацию поста: ${rejectedIds.join(', ')}` };
}

/**
 * Темы советов Кузьмича — каждая со своим РЕАЛЬНЫМ снимком Камчатки.
 *
 * Раньше советы уходили в канал текстом: postKuzmichTip звал postToAllChannels
 * без photoUrl, хотя фото-путь (tgPostPhoto, снимки в public/images) давно
 * работал у постов о местах. В ленте это заметно — соседние каналы идут с
 * картинкой, наш совет выглядит голым.
 *
 * Картинка привязана к теме жёстко, а не выбирается моделью и не генерируется:
 * решение 2026-07-17 — AI-пейзажи не показываем. Лучше честный снимок наших
 * термов под совет про термы, чем красивый нарисованный мозг под пост о
 * Камчатке.
 */
interface TipTopic {
  topic: string;
  /** Путь в public/images — проверяется тестом на существование файла. */
  photo: string;
}

const KUZMICH_TIP_TOPICS: TipTopic[] = [
  { topic: 'как правильно выбрать время для поездки на Камчатку',        photo: '/images/categories/vulkany.jpg' },
  { topic: 'что взять с собой на вулкан — и чего точно не стоит',        photo: '/images/activities/volcanoes.jpg' },
  { topic: 'почему рыбалка на Камчатке — это не только про рыбу',        photo: '/images/activities/fishing.jpg' },
  { topic: 'как не облажаться с погодой на Камчатке',                    photo: '/images/categories/morskie.jpg' },
  { topic: 'чем Камчатка отличается от любого другого путешествия',      photo: '/images/bento/khalaktyr.jpg' },
  { topic: 'почему термальные источники лучше любого пятизвёздочного спа', photo: '/images/categories/termy.jpg' },
  { topic: 'как местные относятся к медведям — и как надо вести себя туристу', photo: '/images/hero/bears-kurilskoye.jpg' },
  { topic: 'зачем ехать на Камчатку не в август, а в другое время',      photo: '/images/activities/snowmobile.jpg' },
  { topic: 'что туристы чаще всего недооценивают в поездке на Камчатку', photo: '/images/activities/volcanoes.jpg' },
];

/** Темы — для теста и для админки. */
export const KUZMICH_TIP_TOPIC_LIST: ReadonlyArray<TipTopic> = KUZMICH_TIP_TOPICS;

/**
 * Генерирует практичный совет от Кузьмича и публикует в канал.
 */
export async function postKuzmichTip(): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const picked = KUZMICH_TIP_TOPICS[Math.floor(Math.random() * KUZMICH_TIP_TOPICS.length)];
  const topic = picked.topic;
  const appUrl = getPublicBaseUrl();

  const prompt = `Ты — Кузьмич, камчадал в третьем поколении. Напиши практичный совет для Telegram-канала.

Тема: ${topic}

Требования:
- 60-90 слов, разговорный стиль, как объясняешь знакомому
- Конкретный совет, никаких общих слов
- Немного юмора или самоиронии
- HTML-теги: <b>жирный</b>, <i>курсив</i>
- В конце можно добавить: ${appUrl}/routes
${KUZMICH_CHANNEL_VOICE}`;

  const text = await callAIWithModelDirect([{ role: 'user', content: prompt }], getModelForAgent('kuzmich'));
  const result = await postToAllChannels({ channelId, postType: 'kuzmich_tip', text, photoUrl: `${appUrl}${picked.photo}` });

  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['kuzmich_tip', JSON.stringify({ topic, photo: picked.photo })]
      );
    } catch { /* таблица ещё не создана */ }
  }

  return result;
}

// ── А3. Кузьмич — AI-пост о конкретном туре (автономный cron, 24.08) ────────
//
// Три автопоста в сутки (route/tip/sezon) ни разу не упоминали operator_tours —
// канал двигал трафик на бесплатные точки/маршруты и ни разу на то, что реально
// бронируется. Владелец 24.08: «почему нет туров?» — дыра в дизайне, не баг
// одной строчки: пайплайн писали для точек, тур как сущность в него не завели.

interface TourProgramStep { title?: string; text?: string }

interface KuzmichTourRow {
  id: number;
  title: string;
  short_description: string | null;
  description: string | null;
  base_price: string | null;
  duration_hours: number | null;
  program: TourProgramStep[] | null;
  included: string[] | null;
  photos: string[] | null;
  operator_name: string | null;
}

/**
 * Не повторяем тур раньше N дней. 30, как у маршрутов, здесь не годится —
 * живых туров единицы (замер 23.08: 8), и такая пауза быстро оставила бы
 * пул пустым при посте через день. 7 дней даёт каждому туру пройти круг
 * примерно дважды в месяц при текущем размере пула.
 */
const TOUR_REPEAT_COOLDOWN_DAYS = 7;

/**
 * Выбирает опубликованный тур, не постившийся последние
 * TOUR_REPEAT_COOLDOWN_DAYS дней, пишет пост голосом Кузьмича по РЕАЛЬНЫМ
 * полям тура (описание, программа дня, что включено, цена) и публикует.
 * Логирует в ai_actions_log — тем же способом, что и посты о маршрутах.
 */
export async function postKuzmichTour(): Promise<{ ok: boolean; tourId?: number; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  const pickResult = await query<KuzmichTourRow>(`
    SELECT ot.id, ot.title, ot.short_description, ot.description,
           ot.base_price::text AS base_price, ot.duration_hours,
           ot.program, ot.included, ot.photos,
           p.name AS operator_name
      FROM operator_tours ot
      LEFT JOIN partners p ON p.id = ot.operator_id
     WHERE ot.is_published = TRUE AND ot.is_active = TRUE AND ot.deleted_at IS NULL
       -- Тур без фотографий в канал не идёт ВООБЩЕ (правило владельца 05.08,
       -- как у tour-channel-post): рисованной обложки у тура быть не может, а
       -- голый текст продаёт хуже, чем не продаёт. Фильтр здесь, а не после
       -- выбора: иначе бесфотный тур занял бы слот прогона и пост не вышел бы.
       AND COALESCE(array_length(ot.photos, 1), 0) > 0
       AND ot.id::text NOT IN (
         SELECT metadata->>'tour_id' FROM ai_actions_log
          WHERE action_type = 'kuzmich_tour_post'
            AND created_at > NOW() - INTERVAL '7 days'
            AND metadata->>'tour_id' IS NOT NULL
       )
     ORDER BY COALESCE(array_length(ot.photos, 1), 0) DESC, RANDOM()
     LIMIT 1
  `);

  const t = pickResult.rows[0];
  if (!t) {
    return {
      ok: false,
      error: `Нет туров для поста (все с фото опубликованы в последние ${TOUR_REPEAT_COOLDOWN_DAYS} дней, либо активных туров с фотографиями нет)`,
    };
  }

  const appUrl = getPublicBaseUrl();

  const programCtx = (t.program ?? []).slice(0, 3)
    .map((step) => [step.title, step.text?.slice(0, 150)].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n');
  const includedCtx = (t.included ?? []).slice(0, 5).join(', ');
  const priceCtx = t.base_price && parseFloat(t.base_price) > 0
    ? `от ${Math.round(parseFloat(t.base_price)).toLocaleString('ru-RU')} ₽`
    : '';

  const prompt = `Ты — Кузьмич, местный житель Камчатки. Напиши короткий пост для Telegram-канала о конкретном туре — реальном предложении, которое можно забронировать у оператора.

Тур: ${t.title}
Оператор: ${t.operator_name ?? 'неизвестен'}
Описание: ${(t.short_description || t.description || '').slice(0, 300) || 'нет данных'}
${programCtx ? `Программа дня:\n${programCtx}` : ''}
${includedCtx ? `Включено: ${includedCtx}` : ''}
${t.duration_hours ? `Длительность: ${t.duration_hours} ч` : ''}
${priceCtx ? `Цена: ${priceCtx}` : ''}

Требования:
- 60-100 слов; если фактуры мало — короче, не разбавляй общими словами
- Конкретная деталь ИЗ ДАННЫХ ВЫШЕ — из описания или программы дня. Не выдумывай
  подробностей, которых там нет: ни маршрута, ни ощущений, которых нет в тексте
- Дай почувствовать сам тур — что реально происходит в этот день, а не рекламный ярлык
- Упомяни оператора по имени: это его тур, не наш
- Цену указывай, только если она есть в данных выше, и ровно ту цифру
- В конце — ссылка: ${appUrl}/marketplace/tours/${t.id}
- HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
- Не начинай с "Привет" или своего имени
${KUZMICH_CHANNEL_VOICE}`;

  const text = await callAIWithModelDirect([{ role: 'user', content: prompt }], getModelForAgent('kuzmich'));

  // Настоящие снимки оператора, АЛЬБОМОМ (до 10) — тот же путь и та же
  // абсолютизация URL, что у tour-channel-post: прежняя склейка
  // `${appUrl}${photoRel}` ломала уже-абсолютные ссылки, и Telegram, не
  // скачав битый URL, молча ронял пост тура в голый текст.
  const photoUrls = absolutePhotoUrls(t.photos, appUrl);
  if (photoUrls.length === 0) {
    // SQL выше такого не отдаёт; ветка — страховка от рассинхрона (§4.0):
    // тур без фото в канал не публикуется никогда, ни текстом, ни обложкой.
    return { ok: false, tourId: t.id, error: `У тура ${t.id} нет пригодных фотографий — пост не публикуется` };
  }

  const result = await postToAllChannels({ channelId, postType: 'kuzmich_tour', text, photoUrls });

  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['kuzmich_tour_post', JSON.stringify({ tour_id: t.id, tour_title: t.title })]
      );
    } catch { /* таблица ещё не создана — не блокируем пост */ }
  }

  return { ...result, tourId: t.id };
}

// ── AI News channel post ─────────────────────────────────────────────────────

import type { IntelligenceFinding } from '@/lib/services/intelligence-monitor.service';
import { hashStr } from '@/lib/notifications/post-image';
import { resolveCoverImage } from '@/lib/notifications/cover-image';
import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert } from '@/lib/notifications/pd-alert';

/**
 * Фактчек перед публикацией — те же два эшелона, что у scout-digest, по одной
 * переписи на каждый. Инцидент 31.07: в AI-канал ушёл пост с перенесёнными
 * числами («YDB ускоряет в 3 раза», «llama.cpp: прирост качества до 300%») —
 * гейты жили только в scout-digest, а этот конвейер публиковал без проверки.
 * Источник истины — ТОЛЬКО сниппеты сигналов (finding.summary сам является
 * выходом LLM и числа из него подтверждением не считаются).
 * null — пост не прошёл: лучше не выпустить, чем выпустить с выдумкой.
 */
async function factGatedText(
  post: string,
  sources: string,
  originalPrompt: string,
): Promise<string | null> {
  let text = post;

  let bad = unsourcedPercents(text, sources);
  if (bad.length > 0) {
    const retry = await callAIQuality([
      { role: 'user', content: originalPrompt },
      { role: 'assistant', content: text },
      { role: 'user', content: `В тексте есть числа (проценты/кратности), которых НЕТ в источниках: ${bad.join(', ')}. Перепиши пост, убрав все неподтверждённые числа (формулируй без них). Верни только исправленный текст.` },
    ], { maxTokens: 1200 }).catch(() => null);
    if (retry) { text = retry; bad = unsourcedPercents(text, sources); }
    if (bad.length > 0) return null;
  }

  let claims = await unsupportedClaims(text, sources);
  // null — судья НЕ ответил (провайдер молчит). Раньше сбой возвращал [] и
  // пост уходил непроверенным (инцидент GPT-Realtime 01.08). Теперь сбой
  // судьи = отмена: гейт, который не работает, обязан закрываться, а не
  // открываться.
  if (claims === null) return null;
  if (claims.length > 0) {
    const retry = await callAIQuality([
      { role: 'user', content: originalPrompt },
      { role: 'assistant', content: text },
      { role: 'user', content: `Эти утверждения НЕ подтверждаются источниками (выдумка или искажение): ${claims.join(' | ')}. Перепиши пост строго по источникам, не добавляя новых непроверенных фактов. Верни только исправленный текст.` },
    ], { maxTokens: 1200 }).catch(() => null);
    if (retry) { text = retry; claims = await unsupportedClaims(text, sources); }
    // После переписи: и остаток выдумок, и повторный сбой судьи — отмена.
    if (claims === null || claims.length > 0) return null;
  }

  return text;
}

/**
 * Publishes an AI/tech intelligence finding to the public AI news channel.
 * Generates an engaging post via AI + a Pollinations.ai image.
 * Only called for ai_tech domain, notable/critical urgency.
 */
export async function postAINewsToChannel(
  finding: IntelligenceFinding,
  opts: { skipLLM?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_AI_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_AI_CHANNEL_ID not set' };

  // 1. Контекст сигналов. Сниппет целиком (intelligence-monitor хранит до
  // 400 символов): 200-символьные огрызки приглашали модель дописывать факты.
  const signalCtx = finding.signals
    .slice(0, 5)
    .map((s, i) => `[${i + 1}] ${s.title} (${s.source})\n${s.snippet.slice(0, 400)}`)
    .join('\n\n');

  // 2. AI generates engaging Telegram post.
  // action_items сюда НЕ подаются: это внутренние рекомендации «что сделать
  // TourHab» — из-за них платформа всплывала в публичном посте чужого канала.
  const postPrompt = `Ты — редактор AI-канала. Напиши пост для публичного Telegram-канала про AI и заработок на технологиях.

ИСХОДНЫЕ ДАННЫЕ:
Анализ: ${finding.summary}

ИСТОЧНИКИ:
${signalCtx}

ТРЕБОВАНИЯ:
- 80-150 слов, живой стиль, без канцелярита
- Заголовок жирным (<b>текст</b>)
- 2-3 ключевых факта из источников
- Только то, что есть в источниках: никаких «что это значит для бизнеса»,
  если источники сами такого вывода не делают. Нет вывода — пост заканчивается
  фактами, это нормально
- В конце хэштеги: #AI + 2-3 релевантных (#LLM #OpenAI #DeepSeek и т.д.)
- HTML-теги для Telegram: <b> <i> <a href="url">текст</a>
- Без markdown (* ** # \`\`\`), без эмодзи
- Пиши на русском`;

  // Запасной текст собирается из самой находки — без модели, поэтому годен
  // всегда. Нужен и при исключении, и при заглушке отказа (см. ниже).
  // Без action_items: внутренние рекомендации платформе не для публичного канала.
  const fromFinding = (): string => `<b>AI Intelligence</b>\n\n${esc(finding.summary)}`;

  let postText: string;
  if (opts.skipLLM) {
    // Тест канала из админки: НЕ ждём LLM. Синхронная генерация текста
    // (callAIQuality: DeepSeek→Qwen→waterfall) плюс постинг с ретраями
    // перелезала таймаут прокси Timeweb → кнопка отдавала «Failed to fetch».
    // Тест проверяет сам канал (пост + фото доходят), а не качество текста —
    // берём детерминированный текст из находки и укладываемся в таймаут.
    postText = fromFinding();
  } else {
    try {
      // Качественный путь, а не gemini-2.0-flash-001 (февраль 2025). Эти два
      // генератора были единственными в файле на захардкоженной старой модели —
      // остальное давно на флагмане. Публичные посты писала самая слабая модель
      // в стеке; отсюда и выдумки, и эмодзи вопреки прямому запрету в промпте.
      postText = await callAIQuality([{ role: 'user', content: postPrompt }], { maxTokens: 1200 });
    } catch {
      postText = fromFinding();
    }
  }

  // Отказ AI приходит СТРОКОЙ, а не исключением: callAIWithModelDirect →
  // callAIWithModel → (модель недоступна) → callAIWaterfall → при отказе всех
  // провайдеров возвращается заглушка. catch выше при этом не срабатывает.
  // Именно так 25.07.2026 в AI-канал ушёл пост «Сервис временно недоступен.».
  if (blockingTextIssue(postText)) {
    postText = fromFinding();
  }
  // Находка тоже могла оказаться пустой — тогда публиковать нечего.
  const issue = blockingTextIssue(postText);
  if (issue) {
    const error = `Публикация отменена: ${issue}`;
    console.error('[postAINewsToChannel]', error);
    return { ok: false, error };
  }

  // Фактчек перед публикацией (инцидент 31.07). В тест-режиме админки
  // (skipLLM) гейт пропускается: тест проверяет доставку в канал, а не текст,
  // и не должен ждать LLM.
  if (!opts.skipLLM) {
    const gated = await factGatedText(postText, signalCtx, postPrompt);
    if (!gated) {
      const error = 'Публикация отменена: факты поста не подтверждаются источниками';
      console.error('[postAINewsToChannel]', error);
      return { ok: false, error };
    }
    postText = gated;
  }

  // 3. Generate image — сюжет/стиль/палитра от хэша новости, а не один и тот
  // же «неоновый мозг» на каждый пост (см. lib/notifications/post-image.ts)
  // 3. Обложка: умный путь (DashScope Qwen-Image) при включённой модели, иначе
  // детерминированный Pollinations. В тест-режиме (skipLLM) — сразу Pollinations,
  // чтобы не растянуть цепочку и не словить таймаут («Failed to fetch»).
  const seed = hashStr(finding.summary) % 9_999_999;
  const cover = await resolveCoverImage(finding.summary, 'ai', seed, {
    skipSmartImage: opts.skipLLM,
  });

  // 4. Тот же текстовый гейт, что и у остальных постов. Этот публикатор не
  //    ходит через postToAllChannels — у него свой канал, — и потому легко
  //    остаётся без общей проверки: ровно так и вышло после 12.07.
  //    В тест-режиме админки пропускается вместе с фактчеком: тест проверяет
  //    доставку, а не текст, и не должен ждать сетевых проб.
  if (!opts.skipLLM) {
    const textCheck = await validateTextPost(postText);
    for (const w of textCheck.warnings) console.error('[postAINewsToChannel] предупреждение:', w);
    if (!textCheck.valid) {
      const error = `Публикация отменена: ${textCheck.errors.join('; ')}`;
      console.error('[postAINewsToChannel]', error);
      await logValidationFailure('ai_news', textCheck);
      return { ok: false, error };
    }
  }

  // 5. Publish to AI channel (photo + caption)
  const result = await tgPostPhoto(channelId, cover.url, postText);

  // 5. Log action
  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['ai_news_post', JSON.stringify({
          domain: finding.domain,
          urgency: finding.urgency,
          summary: finding.summary.slice(0, 200),
          signals_count: finding.signals.length,
        })],
      );
    } catch { /* not critical */ }
  }

  return result;
}

/**
 * Publishes a travel industry intelligence finding to TourHub channel with image.
 * Only called for travel_industry domain, notable/critical urgency.
 */
export async function postTravelNewsToChannel(finding: IntelligenceFinding): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  // 1. Контекст сигналов — сниппет целиком (см. postAINewsToChannel: огрызки
  // приглашают модель дописывать факты).
  const signalCtx = finding.signals
    .slice(0, 3)
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet.slice(0, 400)}`)
    .join('\n\n');

  // 2. AI generates post for tourists/platform users.
  // action_items не подаются — внутренние рекомендации платформе, не контент канала.
  const postPrompt = `Ты — маркетолог туристической платформы Камчатки. Напиши пост для публичного Telegram-канала про новости в туристической индустрии.

ИСХОДНЫЕ ДАННЫЕ:
Анализ: ${finding.summary}

ИСТОЧНИКИ:
${signalCtx}

ТРЕБОВАНИЯ:
- 80-120 слов, увлекательный стиль, актуально для туристов
- Заголовок жирным про туризм/путешествия
- 2-3 факта из источников (регуляции, цены, новые маршруты, тренды)
- Только то, что есть в источниках: никаких «как это влияет на туры Камчатки»,
  если источники сами об этом не говорят. Нет связи с Камчаткой — пост
  заканчивается фактами, это нормально
- В конце ссылка: <a href="https://vedarai.ru/routes">Наши маршруты →</a>
- Хэштеги: #Путешествия #Туризм #Камчатка
- HTML-теги для Telegram: <b> <i> <a>
- Без markdown (* ** #), без эмодзи
- Пиши на русском`;

  let postText: string;
  try {
    // Качественный путь, а не gemini-2.0-flash-001 (февраль 2025). Эти два
    // генератора были единственными в файле на захардкоженной старой модели —
    // остальное давно на флагмане. Публичные посты писала самая слабая модель
    // в стеке; отсюда и выдумки, и эмодзи вопреки прямому запрету в промпте.
    postText = await callAIQuality([{ role: 'user', content: postPrompt }], { maxTokens: 1200 });
  } catch {
    // Fallback: сырой summary без action_items (внутренние рекомендации).
    postText = `<b>Новости туризма</b>\n\n${esc(finding.summary)}\n\n<a href="https://vedarai.ru/routes">Наши маршруты →</a>`;
  }

  // Фактчек перед публикацией — тот же гейт, что у AI-канала (инцидент 31.07).
  {
    const gated = await factGatedText(postText, signalCtx, postPrompt);
    if (!gated) {
      const error = 'Публикация отменена: факты поста не подтверждаются источниками';
      console.error('[postTravelNewsToChannel]', error);
      return { ok: false, error };
    }
    postText = gated;
  }

  // 3. Обложка: умный путь (DashScope Qwen-Image) при включённой модели, иначе
  // детерминированный камчатский сюжет от хэша новости через Pollinations.
  const seed = hashStr(finding.summary) % 9_999_999;
  const cover = await resolveCoverImage(finding.summary, 'travel', seed);

  // 4. Publish to TourHub channel (with MAX parallel post)
  const result = await postToAllChannels({ channelId, postType: 'travel_news', text: postText, photoUrl: cover.url });

  // 5. Log action
  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['travel_news_post', JSON.stringify({
          domain: finding.domain,
          urgency: finding.urgency,
          summary: finding.summary.slice(0, 200),
          signals_count: finding.signals.length,
        })],
      );
    } catch { /* not critical */ }
  }

  return result;
}

// ── Safety/News post ─────────────────────────────────────────────────────────

/** Parse RSS headlines (lightweight) */
function parseRssItems(xml: string, limit = 8): Array<{ title: string; text: string; date: string }> {
  const items: Array<{ title: string; text: string; date: string }> = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
    const descM = block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/);
    const fullM = block.match(/<yandex:full-text>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/yandex:full-text>/);
    const dateM = block.match(/<pubDate>(.*?)<\/pubDate>/);
    if (titleM?.[1]) {
      const body = (fullM?.[1] ? stripTags(fullM[1]).slice(0, 600) : undefined) ?? descM?.[1] ?? '';
      items.push({ title: titleM[1].trim(), text: body.trim(), date: dateM?.[1] ?? '' });
    }
  }
  return items;
}

/**
 * Fetches latest Kamchatka news, finds safety-relevant stories,
 * generates AI post + image, publishes to channel.
 */
export async function postSafetyToChannel(topic?: string): Promise<{ ok: boolean; error?: string }> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID not set' };

  // 1. Fetch Kamchatka news
  let newsItems: Array<{ title: string; text: string; date: string }> = [];
  try {
    const res = await fetch('https://kamchatka.aif.ru/rss/all.php', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const xml = await res.text();
      newsItems = parseRssItems(xml, 15);
    }
  } catch { /* feed unavailable */ }

  // Filter for safety/tourism relevant news
  const safetyKeywords = ['турист', 'безопасн', 'спасат', 'мчс', 'погиб', 'пострад', 'поиск', 'эвакуац', 'вулкан', 'извержен', 'медвед', 'шторм', 'лавин'];
  const safetyNews = newsItems.filter(n => {
    const lower = (n.title + ' ' + n.text).toLowerCase();
    return safetyKeywords.some(kw => lower.includes(kw));
  });

  const relevantNews = safetyNews.length > 0 ? safetyNews : newsItems.slice(0, 3);
  const newsContext = relevantNews.map(n => `${n.title}: ${n.text.slice(0, 300)}`).join('\n\n');

  // 2. Generate post via AI
  const userTopic = topic ? `\nТема от админа: ${topic}\n` : '';
  const postPrompt = `Ты — Кузьмич, AI-агент платформы TourHab. Напиши пост для Telegram-канала о безопасности туристов на Камчатке.
${userTopic}
АКТУАЛЬНЫЕ НОВОСТИ:
${newsContext || 'Нет свежих новостей — напиши общий пост о безопасности.'}

ТРЕБОВАНИЯ:
- 100-150 слов
- Заголовок жирным (<b>текст</b>)
- Факты из новостей, без выдумок
- Практичные советы (3-5 пунктов, через дефис)
- Экстренный номер: только 112 (работает без баланса и SIM). Региональные номера МЧС не указывай.
- В конце ссылка: <a href="https://vedarai.ru/routes">Безопасные туры с проверенными операторами</a>
- HTML-теги для Telegram: <b> <i> <a>
- Без markdown (* ** #)
- Без эмодзи
- Спокойный серьёзный тон — Кузьмич предупреждает, не пугает
${KUZMICH_CHANNEL_VOICE}`;

  const postText = await callAIWithModelDirect([{ role: 'user', content: postPrompt }], getModelForAgent('kuzmich'));

  // 3. Generate image
  const imagePrompt = safetyNews.length > 0 && safetyNews[0].title.toLowerCase().includes('перевал')
    ? 'dramatic winter mountain pass in Kamchatka Russia, blizzard snow storm, dangerous weather, rescue helicopter, dark stormy sky, photorealistic, cinematic, 8K, no people, no text, no watermarks'
    : 'Kamchatka wilderness safety concept, volcanic mountain landscape, dramatic weather, moody atmosphere, trail markers, photorealistic, cinematic, 8K, no people, no text, no watermarks';
  const seed = Math.floor(Math.random() * 9999999);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1280&height=720&seed=${seed}&nologo=true`;

  // 4. Publish to all channels
  const result = await postToAllChannels({ channelId, postType: 'safety', text: postText, photoUrl: imageUrl });

  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['kuzmich_safety_post', JSON.stringify({ topic: topic ?? 'auto', news_count: relevantNews.length })]
      );
    } catch { /* not critical */ }
  }

  return result;
}

// ── Б. Оперативные уведомления (в admin-чат) ─────────────────────────────────

/**
 * Дублирует лид в централизованный admin-чат (TELEGRAM_CHAT_ID).
 * Вызывается fire-and-forget из /api/leads.
 */
interface LeadSourceData {
  source?: string;
  interests?: string[];
  date_from?: string;
  date_to?: string;
  arrival?: string;
  departure?: string;
  trip_days?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer?: string;
}

const LEAD_SOURCE_LABELS: Record<string, string> = {
  telegram_bot:        'Телеграм-бот',
  telegram_lead_flow:  'ТГ-бот (форма)',
  trip_planner:        'TripPlanner',
  website:             'Сайт',
  homepage_cta:        'Главная (CTA)',
  route_page:          'Страница маршрута',
  max_bot:             'MAX-бот',
  widget:              'Виджет партнёра',
  booking_intake_bot:  'AI-бронирование',
};

const LEAD_INTEREST_LABELS: Record<string, string> = {
  volcano: 'Вулкан', trekking: 'Треккинг', fishing: 'Рыбалка',
  thermal: 'Термальный', helicopter: 'Вертолёт', boat_trip: 'Море',
  snowmobile: 'Снегоходы', skiing: 'Лыжи', diving: 'Дайвинг',
  kayak: 'Байдарки', photography: 'Фото', other: 'Другое',
};

export async function notifyAdminNewLead(lead: {
  id: string;
  name: string;
  phone: string;
  comment?: string | null;
  routeTitle?: string | null;
  sourceUrl?: string | null;
  sourceData?: Record<string, unknown> | null;
  score?: number;
  labelRu?: string;
}): Promise<void> {
  const sd = lead.sourceData as LeadSourceData | null | undefined;
  const interests = sd?.interests ?? [];
  const dateFrom  = sd?.date_from ?? sd?.arrival;
  const dateTo    = sd?.date_to   ?? sd?.departure;
  const source    = sd?.source ? (LEAD_SOURCE_LABELS[sd.source] ?? sd.source) : null;

  const scoreText = lead.score != null ? ` \u00b7 ${lead.score}/100` : '';
  const label = lead.labelRu ? ` (${lead.labelRu})` : '';
  const title = source
    ? `<b>Лид — ${esc(source)}${label}${scoreText}</b>`
    : `<b>Новый лид${label}${scoreText}</b>`;

  const baseUrl = getPublicBaseUrl();

  const lines = [
    title,
    '',
    `<b>Имя:</b> ${esc(lead.name)}`,
    `<b>Тел:</b> <code>${esc(lead.phone)}</code>`,
  ];

  if (interests.length > 0) {
    const labels = interests.map(i => LEAD_INTEREST_LABELS[i] ?? i).join(', ');
    lines.push(`<b>Интересы:</b> ${esc(labels)}`);
  }
  if (dateFrom) {
    lines.push(`<b>Даты:</b> ${esc(dateFrom)} — ${dateTo ? esc(dateTo) : '?'}`);
  }
  if (sd?.trip_days) lines.push(`<b>Длина:</b> ${sd.trip_days} дн.`);
  if (lead.comment) {
    const preview = lead.comment.length > 300 ? lead.comment.slice(0, 300) + '\u2026' : lead.comment;
    lines.push(`<b>Сообщение:</b> ${esc(preview)}`);
  }
  if (lead.routeTitle) lines.push(`<b>Маршрут:</b> ${esc(lead.routeTitle)}`);
  if (lead.sourceUrl) lines.push(`<b>Страница:</b> ${esc(lead.sourceUrl)}`);
  lines.push('', `<code>${esc(lead.id)}</code>`);

  // Заглушка без ПД — на случай, когда MAX недоступен: о лиде узнают, но имя
  // и телефон остаются за логином, в Telegram они не уходят.
  const stub = [
    title,
    '',
    `Заявка <code>${esc(lead.id)}</code>${source ? ` — ${esc(source)}` : ''}.`,
    lead.routeTitle ? `Маршрут: ${esc(lead.routeTitle)}` : '',
    'Имя и телефон — в кабинете: MAX недоступен, в Telegram они не передаются.',
  ].filter(Boolean).join('\n');

  const res = await sendPdAlert({
    text: lines.join('\n'),
    stub,
    buttons: [
      { text: 'Позвонил', payload: `lead_contacted:${lead.id}` },
      { text: 'Квалифицирован', payload: `lead_qualified:${lead.id}` },
      { text: 'Сделка!', payload: `lead_converted:${lead.id}` },
      { text: 'Отказ', payload: `lead_lost:${lead.id}` },
      { text: 'Открыть в CRM', url: `${baseUrl}/hub/operator/leads/${lead.id}` },
    ],
  });

  // Логируем попытку в ai_actions_log. Исход записывается по имени канала:
  // «ушла заглушка» — это не доставка, и зелёным выглядеть не должно.
  void query(
    `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
    [
      'lead_notification',
      JSON.stringify({
        lead_id: lead.id,
        channel: res.channel,
        delivered: res.delivered,
        reason: res.reason.slice(0, 200),
        score: lead.score ?? null,
        source: source ?? 'unknown',
      }),
    ],
  ).catch(() => {});

  if (!res.delivered) {
    console.error(`[notifyAdminNewLead] ПД не доставлены: ${res.channel} — ${res.reason}`);
  }
}

/**
 * Дублирует новое бронирование в централизованный admin-чат (TELEGRAM_CHAT_ID).
 * Вызывается fire-and-forget из /api/bookings.
 */
export async function notifyAdminNewBooking(booking: {
  id: string;
  tourName: string;
  departureDate: string;
  participants: number;
  totalAmount: number;
  touristName: string;
  touristEmail: string;
}): Promise<void> {
  const date = new Date(booking.departureDate).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const common = [
    '<b>Новое бронирование</b>',
    '',
    `<b>Тур:</b> ${esc(booking.tourName)}`,
    `<b>Дата:</b> ${date}`,
    `<b>Участников:</b> ${booking.participants}`,
    `<b>Сумма:</b> ${booking.totalAmount.toLocaleString('ru-RU')} ₽`,
    '',
  ];

  const res = await sendPdAlert({
    text: [
      ...common,
      `<b>Гость:</b> ${esc(booking.touristName)}`,
      `<b>Email:</b> ${esc(booking.touristEmail)}`,
      '',
      `<code>${esc(booking.id)}</code>`,
    ].join('\n'),
    stub: [
      ...common,
      `<code>${esc(booking.id)}</code>`,
      'Имя и почта гостя — в MAX и в кабинете.',
    ].join('\n'),
    buttons: [{ text: 'Открыть бронь', url: `${getPublicBaseUrl()}/hub/operator/bookings/${booking.id}` }],
  });
  if (!res.delivered) {
    console.error(`[notifyAdminNewBooking] ПД не доставлены (${res.channel}) — ${res.reason}`);
  }
}
