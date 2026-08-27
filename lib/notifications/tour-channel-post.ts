/**
 * Публикация тура оператора в туристический канал — с настоящими фотографиями.
 *
 * Решение владельца 05.08: Кузьмич публикует тур в канале про туризм, с
 * фотографиями. Отсюда два жёстких правила, оба выстраданных на этой карточке.
 *
 * 1. ФОТО — ТОЛЬКО НАСТОЯЩИЕ, из `operator_tours.photos` (снимки оператора,
 *    восстановлены миграцией 813). Никаких сгенерированных обложек: у ручных
 *    постов обложку рисует модель, и для новостного текста это честно, а для
 *    продажи конкретного тура — нет. Турист увидел бы вымышленную реку и
 *    поехал на настоящую. Нет фотографий — поста нет.
 *
 * 2. ТЕКСТ — ТОЛЬКО ИЗ ПОЛЕЙ БАЗЫ. Ни одного эпитета от себя. Я уже вписывал в
 *    программу «знаменитые пирожки» и «сбор в Паратунской зоне» — владелец
 *    поймал оба, и это стоило миграции 814. В канале цена ошибки выше: пост
 *    уходит подписчикам и не правится.
 *
 * Идемпотентность — по хэшу текста, как у ручных постов: повторный запуск
 * workflow не задваивает пост в канале.
 */

import { createHash } from 'node:crypto';
import { query } from '@/lib/database';
import { getPublicBaseUrl } from '@/lib/config';
import { tgPostMediaGroup } from '@/lib/notifications/telegram-channel';
import { activityLabel, difficultyLabel, priceUnitLabel } from '@/lib/tours/labels';
// Правило абсолютизации вынесено в photo-urls (одно на этот модуль и на
// kuzmich_tour-постер) — реэкспорт сохраняет прежний публичный контракт.
export { absolutePhotoUrls, MAX_PHOTOS } from '@/lib/notifications/photo-urls';
import { absolutePhotoUrls } from '@/lib/notifications/photo-urls';

export interface TourPostRow {
  id: string;
  title: string;
  short_description: string | null;
  base_price: string | number | null;
  price_unit: string | null;
  duration_hours: string | number | null;
  multi_day_count: number | null;
  max_participants: number | null;
  difficulty: string | null;
  activity_type: string | null;
  location: string | null;
  photos: string[] | null;
  operator_name: string | null;
}

/** Telegram обрезает подпись альбома после 1024 символов. */
export const CAPTION_LIMIT = 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Длительность словами из тех полей, что реально заполнены. */
function durationLine(row: TourPostRow): string | null {
  const days = row.multi_day_count ?? 0;
  if (days > 1) return `${days} дн.`;
  const hours = row.duration_hours == null ? null : Number(row.duration_hours);
  if (hours && hours > 0) return hours >= 8 ? '1 день' : `${hours} ч.`;
  return days === 1 ? '1 день' : null;
}

/**
 * Текст поста. Строится строго из переданных полей: если поля нет — строки нет.
 * Ни одного слова «от себя» — см. заголовок файла.
 */
export function buildTourPostText(row: TourPostRow, baseUrl: string): string {
  const lines: string[] = [];

  const kind = activityLabel(row.activity_type, true);
  if (kind) lines.push(escapeHtml(kind.toUpperCase()));

  lines.push(`<b>${escapeHtml(row.title)}</b>`);

  if (row.short_description) {
    lines.push('');
    lines.push(escapeHtml(row.short_description));
  }

  const facts: string[] = [];
  if (row.location) facts.push(escapeHtml(row.location));
  const dur = durationLine(row);
  if (dur) facts.push(dur);
  if (row.max_participants) facts.push(`до ${row.max_participants} чел.`);
  const diff = difficultyLabel(row.difficulty, true);
  if (row.difficulty && diff) facts.push(escapeHtml(diff));
  if (facts.length > 0) {
    lines.push('');
    lines.push(facts.join(' · '));
  }

  const price = row.base_price == null ? null : Number(row.base_price);
  if (price && price > 0) {
    const unit = priceUnitLabel(row.price_unit, true);
    lines.push('');
    lines.push(`<b>${price.toLocaleString('ru-RU')} ₽</b>${unit ? ` ${escapeHtml(unit)}` : ''}`);
  }

  if (row.operator_name) {
    lines.push(`Оператор: ${escapeHtml(row.operator_name)}`);
  }

  lines.push('');
  lines.push(`<a href="${baseUrl.replace(/\/$/, '')}/catalog/tours/${row.id}">Подробности и бронирование</a>`);

  return lines.join('\n').slice(0, CAPTION_LIMIT);
}

export function tourPostHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export interface TourPostResult {
  ok: boolean;
  duplicate?: boolean;
  photos?: number;
  error?: string;
}

/**
 * Публикует тур в туристический канал. Нет фотографий — не публикует: пост про
 * поездку без единого снимка продаёт хуже, чем не продаёт вовсе, а рисованная
 * обложка вместо реки — обман.
 */
export async function postTourToChannel(tourId: string): Promise<TourPostResult> {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TELEGRAM_CHANNEL_ID не настроен' };

  const { rows } = await query<TourPostRow>(
    `SELECT ot.id::text,
            ot.title,
            ot.short_description,
            ot.base_price,
            ot.price_unit,
            ot.duration_hours,
            ot.multi_day_count,
            ot.max_participants,
            ot.difficulty,
            ot.activity_type,
            ot.location_name AS location,
            ot.photos,
            COALESCE(p.company_name, p.name) AS operator_name
       FROM operator_tours ot
       LEFT JOIN partners p ON p.id = ot.operator_id
      WHERE ot.id::text = $1
        AND ot.deleted_at IS NULL
        AND ot.is_active = true
      LIMIT 1`,
    [tourId],
  );

  const row = rows[0];
  if (!row) return { ok: false, error: `Тур ${tourId} не найден или снят с витрины` };

  const baseUrl = getPublicBaseUrl();
  const photos = absolutePhotoUrls(row.photos, baseUrl);
  if (photos.length === 0) {
    return { ok: false, error: 'У тура нет фотографий — публиковать нечего' };
  }

  const text = buildTourPostText(row, baseUrl);
  const hash = tourPostHash(text);

  try {
    const dup = await query(
      `SELECT 1 FROM ai_actions_log
        WHERE action_type = 'tour_channel_post'
          AND metadata->>'text_hash' = $1
          AND created_at > NOW() - INTERVAL '30 days'
        LIMIT 1`,
      [hash],
    );
    if (dup.rows.length > 0) return { ok: true, duplicate: true, photos: photos.length };
  } catch { /* лог недоступен — публикуем без дедупа, это лучше молчания */ }

  const sent = await tgPostMediaGroup(channelId, photos, text);
  if (!sent.ok) return { ok: false, error: sent.error, photos: photos.length };

  await query(
    `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
    ['tour_channel_post', JSON.stringify({ text_hash: hash, tour_id: row.id, photos: sent.sent })],
  ).catch(() => { /* пост уже ушёл — лог не критичен */ });

  return { ok: true, photos: sent.sent };
}
