/**
 * Ручной пост в публичный канал через бота (@kuzmichai_bot).
 *
 * Владелец пишет пост (или утверждает написанный), содержимое кладётся в
 * .github/triggers/channel-post.json, workflow channel-post.yml доставляет его
 * на прод-эндпоинт /api/cron/channel-post — токен бота есть только на проде.
 *
 * Обложка — тот же детерминированный механизм, что у автоматических постов
 * (lib/notifications/post-image.ts): сюжет/стиль/палитра и seed от хэша текста,
 * либо явные imagePrompt/seed из триггера.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query } from '@/lib/database';
import { hashStr } from '@/lib/notifications/post-image';
import { resolveCoverImage } from '@/lib/notifications/cover-image';
import { tgPostPhoto, tgPostMediaGroup, maxChannelPost } from '@/lib/notifications/telegram-channel';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';

export const ManualChannelPostSchema = z.object({
  /** ai → TELEGRAM_AI_CHANNEL_ID, travel → TELEGRAM_CHANNEL_ID */
  channel: z.enum(['ai', 'travel']),
  /** HTML для Telegram (<b> <i> <a>). Лимит caption у sendPhoto — 1024. */
  text: z.string().min(50, 'Пост короче 50 символов — это не пост')
    .max(1024, 'Telegram обрезает caption после 1024 символов'),
  imagePrompt: z.string().min(10).max(500).optional(),
  /**
   * Настоящие фотографии — альбом sendMediaGroup (2–10 штук), подпись на
   * первой. Пути с нашего сайта ('/images/...') или https-URL. Когда заданы,
   * AI-обложка не генерируется вовсе: пост про реальный тур обязан показывать
   * реальные кадры, а не нейрокартинку — это то же правило, что запрет
   * AI-картинок в OpenGraph (#878).
   */
  photos: z.array(z.string().min(2).max(500)).min(2).max(10).optional(),
  seed: z.number().int().nonnegative().optional(),
  /** Кросс-пост в MAX-канал (госмессенджер). Автоматические публикаторы
   * зеркалят в MAX всегда; у ручных это опция владельца. */
  toMax: z.boolean().optional(),
});

export type ManualChannelPost = z.infer<typeof ManualChannelPostSchema>;

export function resolveChannelId(channel: ManualChannelPost['channel']): string | undefined {
  return channel === 'ai'
    ? process.env.TELEGRAM_AI_CHANNEL_ID
    : process.env.TELEGRAM_CHANNEL_ID;
}

export function manualPostTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Публикует пост. Идемпотентно по тексту: повторный запуск workflow с тем же
 * триггер-файлом (revert, rebase, ручной re-run) не задваивает пост в канале.
 */
export async function publishManualChannelPost(
  post: ManualChannelPost,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const channelId = resolveChannelId(post.channel);
  if (!channelId) {
    return { ok: false, error: `Канал ${post.channel} не настроен (env отсутствует)` };
  }

  const textHash = manualPostTextHash(post.text);
  let tgDuplicate = false;
  try {
    const dup = await query(
      `SELECT 1 FROM ai_actions_log
        WHERE action_type = 'manual_channel_post'
          AND metadata->>'text_hash' = $1
          AND created_at > NOW() - INTERVAL '30 days'
        LIMIT 1`,
      [textHash],
    );
    tgDuplicate = dup.rows.length > 0;
  } catch { /* лог недоступен — публикуем без дедупа, это лучше молчания */ }

  // Дедуп — ПОканальный. Живой случай 27.07: TG-пост ушёл через старый билд
  // (без toMax), MAX пропущен, а общий дедуп заблокировал бы повтор навсегда.
  // Поэтому duplicate по TG не выходит сразу: если toMax запрошен и MAX ещё
  // не доставлялся — догоняем только MAX, TG не задваивая.
  if (tgDuplicate) {
    if (post.toMax) {
      let maxAlready = true; // лог недоступен → не рискуем дублем в MAX
      try {
        const maxDup = await query(
          `SELECT 1 FROM ai_actions_log
            WHERE action_type = 'manual_channel_post_max'
              AND metadata->>'text_hash' = $1
              AND created_at > NOW() - INTERVAL '30 days'
            LIMIT 1`,
          [textHash],
        );
        maxAlready = maxDup.rows.length > 0;
      } catch { /* оставляем maxAlready=true */ }

      if (!maxAlready) {
        let dupCoverUrl: string;
        if (post.photos && post.photos.length >= 2) {
          const first = post.photos[0];
          dupCoverUrl = first.startsWith('/') ? `${SITE_URL}${first}` : first;
        } else {
          const dupSeed = post.seed ?? hashStr(post.text) % 9_999_999;
          const dupCover = await resolveCoverImage(post.text, post.channel, dupSeed, {
            explicitPrompt: post.imagePrompt,
          });
          dupCoverUrl = dupCover.url;
        }
        const maxResult = await maxChannelPost(post.text, dupCoverUrl);
        if (maxResult.ok) {
          try {
            await query(
              `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
              ['manual_channel_post_max', JSON.stringify({ text_hash: textHash })],
            );
          } catch { /* not critical */ }
        }
      }
    }
    return { ok: true, duplicate: true };
  }

  // Настоящие фото заданы — альбом, и никакой AI-обложки: пост про реальный
  // тур показывает реальные кадры. Иначе прежний путь с генерируемой обложкой.
  let result: { ok: boolean; error?: string };
  let coverUrl: string;
  let imageSource: string;

  if (post.photos && post.photos.length >= 2) {
    const urls = post.photos.map((p) => (p.startsWith('/') ? `${SITE_URL}${p}` : p));
    result = await tgPostMediaGroup(channelId, urls, post.text);
    coverUrl = urls[0];
    imageSource = 'real_photos';
  } else {
    // Обложка: умный путь (DashScope Qwen-Image) при включённой модели, иначе
    // детерминированный Pollinations. Явный imagePrompt из триггера имеет приоритет.
    const seed = post.seed ?? hashStr(post.text) % 9_999_999;
    const cover = await resolveCoverImage(post.text, post.channel, seed, {
      explicitPrompt: post.imagePrompt,
    });
    result = await tgPostPhoto(channelId, cover.url, post.text);
    coverUrl = cover.url;
    imageSource = cover.source;
  }

  // MAX — после успешного TG-поста, fire-and-forget (как у автоматических
  // публикаторов): сбой MAX не должен ронять доставку и логирование TG.
  // Успех фиксируется отдельной записью — дедуп по каналам раздельный.
  if (result.ok && post.toMax) {
    maxChannelPost(post.text, coverUrl).then(async r => {
      if (!r.ok) { console.error('[manual-channel-post] MAX error:', r.error); return; }
      try {
        await query(
          `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
          ['manual_channel_post_max', JSON.stringify({ text_hash: textHash })],
        );
      } catch { /* not critical */ }
    }).catch(() => {});
  }

  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['manual_channel_post', JSON.stringify({
          channel: post.channel,
          text_hash: textHash,
          text_preview: post.text.slice(0, 200),
          image_source: imageSource,
          photos_count: post.photos?.length ?? 0,
        })],
      );
    } catch { /* not critical */ }
  }

  return result;
}
