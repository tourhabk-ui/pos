/**
 * POST /api/cron/road-basis — снимки дорожных постов для поиска основания
 * (приказ на фото). Зовёт раннер cron-safety-ingest.yml второй ходкой.
 *
 * Как устроено: ответ safety-ingest называет посты-ограничения со снимком,
 * основание которых ещё не проверено (`road_basis_needed`); раннер скачивает
 * только их (CDN Telegram с Timeweb не открывается — тот же гео-блок, что у
 * t.me) и присылает сюда байтами. Здесь снимок читает зрение
 * (lib/safety/road-basis.ts), и исход записывается у пункта ленты: найдено /
 * не документ / зрение не ответило (повтор через час).
 *
 * Сервер не верит раннеру на слово: пост обязан быть в списке непроверенных
 * прямо сейчас, адрес снимка — с CDN Telegram, размер — в пределах. Иначе
 * зрение (деньги) звалось бы на что угодно.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { readBasisFromImage } from '@/lib/safety/road-basis';
import { applyBasisReading, pendingBasisChecks } from '@/lib/safety/road-basis-queue';
import { TELEGRAM_PHOTO_RE } from '@/lib/services/safety/road-channel';

export const dynamic = 'force-dynamic';

/** Снимок в base64: до ~4 МБ байтов. Фото листа из канала — сотни килобайт. */
const MAX_B64 = 5_600_000;
const MAX_PHOTOS = 3;

const BodySchema = z.object({
  photos: z.array(z.object({
    external_id: z.string().regex(/^t\.me\/[A-Za-z0-9_]{3,64}\/\d{1,9}$/),
    photo_url: z.string().max(2048).regex(TELEGRAM_PHOTO_RE),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    b64: z.string().min(100).max(MAX_B64).regex(/^[A-Za-z0-9+/=\s]+$/),
  })).min(1).max(MAX_PHOTOS),
});

function authorized(req: NextRequest): boolean {
  return timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '');
}

export async function POST(req: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Некорректное тело: ${parsed.error.issues[0]?.path.join('.') ?? ''}` }, { status: 400 });
  }

  let pending: Set<string>;
  try {
    pending = await pendingBasisChecks(parsed.data.photos.map((p) => p.external_id));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[road-basis] список непроверенных не прочитан, SQLSTATE', code);
    return NextResponse.json({ error: 'База не ответила — снимки не разобраны' }, { status: 503 });
  }

  const results: Array<{ external_id: string; outcome: string; reason?: string }> = [];
  for (const photo of parsed.data.photos) {
    if (!pending.has(photo.external_id)) {
      results.push({ external_id: photo.external_id, outcome: 'not_pending' });
      continue;
    }
    const reading = await readBasisFromImage(photo.b64.replace(/\s+/g, ''), photo.mime);
    if (reading.outcome !== 'found') {
      console.error(`[road-basis] ${photo.external_id}: ${reading.outcome} — ${reading.reason}`);
    }
    try {
      // Основание видно глазами там, где снимок: сам пост канала.
      await applyBasisReading(photo.external_id, reading, `https://${photo.external_id}`);
      results.push({
        external_id: photo.external_id,
        outcome: reading.outcome,
        ...(reading.outcome === 'found' ? {} : { reason: reading.reason }),
      });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error(`[road-basis] ${photo.external_id}: исход не записан, SQLSTATE`, code);
      results.push({ external_id: photo.external_id, outcome: 'write_failed', reason: `SQLSTATE ${code}` });
    }
  }
  return NextResponse.json({ success: true, results });
}
