/**
 * POST /api/affiliate/link — партнёрская ссылка через TravelPayouts.
 *
 * Токен наружу не отдаётся, ссылка строится на сервере. Проверка входа —
 * Edge: адреса нет в PUBLIC_API_ROUTES, значит без сессии сюда не попасть.
 *
 * ── Что здесь было не так (разбор периметра 07.09) ────────────────────────
 *
 * Адрес принимал ЛЮБОЙ `url` и возвращал ссылку с НАШИМ маркером. То есть
 * всякий вошедший мог одолжить партнёрский идентификатор платформы под
 * произвольное назначение — и в отчётах TravelPayouts, и в самой ссылке
 * стояли бы мы. Это не утечка данных, это заём репутации и учётной записи.
 *
 * Вызывающих у адреса при этом нет вовсе: по всему репозиторию его не зовёт
 * никто, кроме комментария в самом сервисе. Но «мёртв сегодня» не значит
 * «мёртв завтра», поэтому адрес не снят, а сужен: список назначений назван
 * поимённо. Неизвестный хост — отказ с причиной, а не молчаливая ссылка.
 *
 * Body: { url: string, sub_id?: string }
 * Response: { affiliate_url: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { toAffiliateLink } from '@/lib/services/travelpayouts';

export const dynamic = 'force-dynamic';

/**
 * Куда платформе вообще есть смысл вести партнёрскую ссылку.
 *
 * Список закрытый и поимённый: партнёрская программа платит только за свои
 * витрины, а всё остальное — либо ошибка, либо чужое использование нашего
 * маркера. Расширяется вместе с реальным партнёром, а не «на всякий случай».
 *
 * Сверяется ХОСТ целиком или как поддомен: `evil.com/aviasales.ru` и
 * `aviasales.ru.evil.com` не должны проходить, а `www.aviasales.ru` —
 * должен.
 */
const ALLOWED_HOSTS = [
  'aviasales.ru', 'aviasales.com',
  'hotellook.ru', 'hotellook.com',
  'ostrovok.ru',
  'sutochno.ru',
  'tp.media',
  'travelpayouts.com',
  'yandex.ru',
] as const;

export function isAllowedAffiliateHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const Schema = z.object({
  url:    z.string().url().max(2000),
  sub_id: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Неверные параметры' }, { status: 400 });
  }

  // Причина отказа названа: адрес не «сломался», он не из списка. Молчаливый
  // отказ заставил бы искать ошибку в формате ссылки.
  if (!isAllowedAffiliateHost(parsed.data.url)) {
    return NextResponse.json(
      { error: 'Этот адрес не входит в список партнёрских витрин платформы' },
      { status: 400 },
    );
  }

  const result = await toAffiliateLink(parsed.data.url, parsed.data.sub_id);
  return NextResponse.json({ affiliate_url: result.affiliate_url });
}
