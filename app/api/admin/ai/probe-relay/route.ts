/**
 * GET /api/admin/ai/probe-relay — диагностика флагманского релея (admin).
 *
 * Немота решателя эволюции показывала «пустой ответ» и по OpenRouter, и по
 * Anthropic, хотя релей настроен. Это значит «релей ответил, но текста в
 * ожидаемой форме нет» — а точную причину (несовпадение формы ответа,
 * ошибка-в-200, неверная модель, лимит) прежние логи прятали. Этот эндпоинт
 * дёргает оба пути тем же разбором, что решатель, и возвращает статус + найден
 * ли текст + кусок сырого тела. Дёрнуть на проде — и сразу видно, что чинить.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { probeFlagshipRelay, type RelayProbeLeg } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

/** Человекочитаемый вердикт по одному пути релея — сразу видно, что чинить. */
function verdict(leg: RelayProbeLeg): string {
  if (!leg.key_set) return 'ключ не задан';
  if (leg.text_found) return 'ok';
  if (leg.http_status === null) return 'нет ответа (сеть/timeout) — см. body_sample';
  if (leg.http_status >= 400) return `HTTP ${leg.http_status} — ключ / модель / лимит (см. body_sample)`;
  return `HTTP ${leg.http_status}, но текст не распознан — форма ответа не та или ошибка в теле (см. body_sample)`;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const relay = await probeFlagshipRelay();
  return NextResponse.json({
    success: true,
    flagship_model: relay.flagship_model,
    openrouter: { ...relay.openrouter, verdict: verdict(relay.openrouter) },
    anthropic: { ...relay.anthropic, verdict: verdict(relay.anthropic) },
  });
}
