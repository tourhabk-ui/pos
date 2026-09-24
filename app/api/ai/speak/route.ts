/**
 * POST /api/ai/speak — озвучить ответ Кузьмича (issue #1992).
 * Тело: { text } — текст ответа, как он показан в чате. Ответ: audio/wav.
 *
 * Зачем: на маршруте человек не всегда может смотреть в экран. Путь проверен
 * пробой с прода до постройки кнопки (`/api/cron/voice-probe`, 24.09).
 *
 * ── Открыт анонимам, как и сам чат — поэтому два предохранителя ────────────
 *
 * Синтез платный, а тело присылает клиент. Предохранители:
 *   - частота по IP (как у /api/ai/chat, но строже: озвучка дороже строки);
 *   - общий дневной потолок на процесс. Счётчик в памяти и сбрасывается
 *     перезапуском — это предохранитель от бота, а не бухгалтерия: расход
 *     считается в llm_usage_log (lib/ai/tts.ts).
 * Упёрлись — 429 со словами, кнопка покажет их человеку.
 *
 * ── «Не удалось» не выдаётся за тишину (§4.0) ──────────────────────────────
 *
 * Провайдер отказал — 502, ключа или сети нет — 503; причина в лог, человеку —
 * понятная фраза. Текст обрезан по потолку — заголовок `X-Speech-Truncated: 1`,
 * и кнопка говорит «озвучено начало ответа», а не делает вид, что прочла всё.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { prepareSpeechText, synthesizeSpeech } from '@/lib/ai/tts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Шесть озвучек в минуту с одного адреса — больше человек не прослушает. */
const speakRateLimiter = createRateLimiter({ windowMs: 60_000, max: 6 });

/**
 * Потолок озвучек в сутки на процесс. Сегодня Кузьмичу пишут около пяти раз
 * в день (перепись kuzmich-load-census, 24.09), так что 300 — запас на рост,
 * а не норма. Сменить — env TTS_DAILY_MAX.
 */
export const DEFAULT_DAILY_MAX = 300;

let day = '';
let usedToday = 0;

function dailyMax(): number {
  const n = Number(process.env.TTS_DAILY_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_MAX;
}

/** Берёт место в дневном потолке; false — потолок исчерпан. */
function takeDailySlot(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; usedToday = 0; }
  if (usedToday >= dailyMax()) return false;
  usedToday += 1;
  return true;
}

/** Только для тестов: сбрасывает дневной счётчик. */
export function resetSpeakDailyCounter(): void {
  day = '';
  usedToday = 0;
}

const SpeakSchema = z.object({
  // Сырой ответ может быть длиннее потолка — его обрежет prepareSpeechText.
  text: z.string().trim().min(1, 'Нечего озвучивать').max(8000, 'Слишком длинный текст'),
});

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!speakRateLimiter.check(ip)) {
    return NextResponse.json({ error: 'Слишком часто. Попробуйте через минуту.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ожидался JSON с полем text' }, { status: 400 });
  }
  const parsed = SpeakSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Неверный запрос' }, { status: 400 });
  }

  const { text, truncated } = prepareSpeechText(parsed.data.text);
  if (!text) {
    return NextResponse.json({ error: 'Нечего озвучивать' }, { status: 400 });
  }

  if (!takeDailySlot()) {
    console.error('[ai/speak] дневной потолок озвучек исчерпан:', dailyMax());
    return NextResponse.json({ error: 'Озвучка на сегодня исчерпана. Текст ответа остаётся на экране.' }, { status: 429 });
  }

  const result = await synthesizeSpeech(text);
  if (result.status !== 'ok') {
    console.error(`[ai/speak] голос не получен (${result.status}):`, result.reason);
    return NextResponse.json(
      { error: 'Не удалось озвучить ответ. Текст остаётся на экране.' },
      { status: result.status === 'refused' ? 502 : 503 },
    );
  }

  return new NextResponse(result.audio, {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      'Cache-Control': 'no-store',
      'X-Speech-Truncated': truncated ? '1' : '0',
    },
  });
}
