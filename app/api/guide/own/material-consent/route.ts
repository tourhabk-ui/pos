/**
 * POST /api/guide/own/material-consent — гид сам открывает подпись согласия
 * на показ своих фото и видео на Ведаре (05.11, слово владельца: запись
 * согласия — в той же работе, что фото и видео тура).
 *
 * Согласие — то же, что подписывают партнёры по ссылке менеджера (миграция
 * 1321, CLAUDE.md §0): записанный текст, а не слова. Здесь только выдаётся
 * ссылка на страницу подписи для карточки вошедшего гида; подписывает он
 * сам на /partner-consent. Действующее согласие уже есть — ссылка не
 * выдаётся, ответ называет дату.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { issueConsentInvite, loadPartnerConsents } from '@/lib/partners/material-consent';
import { partnerConsentUrl } from '@/lib/partners/material-consent-rules';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;
  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }
  try {
    const active = (await loadPartnerConsents(partnerId)).find((c) => c.revokedAt === null);
    if (active) {
      return NextResponse.json({ success: true, signedOn: active.grantedOn });
    }
    const invite = await issueConsentInvite(partnerId);
    if (!invite.ok) {
      return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
    }
    return NextResponse.json({ success: true, url: partnerConsentUrl(getPublicBaseUrl(), invite.key) });
  } catch (err) {
    console.error('[guide/own/material-consent] отказ:', `sqlstate=${(err as { code?: string })?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не получилось — попробуйте позже' }, { status: 503 });
  }
}
