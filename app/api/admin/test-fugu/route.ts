/**
 * GET /api/admin/test-fugu?secret=CRON_SECRET&title=Вулкан%20Авачинский
 *
 * Живая проверка модели Sakana Fugu Ultra: генерирует описание камчатского
 * объекта через Fugu И через текущий waterfall — рядом, для сравнения качества.
 *
 * Auth: CRON_SECRET (header Bearer или ?secret=).
 * Ничего не пишет в БД — только сравнение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { callFugu, callAIFast } from '@/lib/ai/providers';
import { verifyCronSecret } from '@/lib/auth/cron';
import type { ChatMessage } from '@/lib/ai/prompts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const title = new URL(request.url).searchParams.get('title')?.trim() || 'Вулкан Авачинский';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты эксперт по туризму на Камчатке. Пишешь краткие, точные описания природных объектов и маршрутов для туристической платформы TourHab.
Стиль: фактически точный, живой, без рекламных штампов. Без emoji. Без markdown.
Длина: 2-3 абзаца, 200-350 слов. Упоминай конкретные детали (координаты, высоту, особенности) если знаешь.`,
    },
    {
      role: 'user',
      content: `Напиши описание для туристического объекта:
Название: ${title}

Описание должно помочь туристу понять: что это за место, чем оно уникально, когда лучше посещать, что стоит знать перед поездкой.`,
    },
  ];

  const fuguT0 = Date.now();
  let fuguText: string | null = null;
  let fuguError: string | null = null;
  try {
    fuguText = await callFugu(messages);
    if (fuguText === null) fuguError = 'callFugu вернул null (нет FUGU_API_KEY, ошибка API или недоступен api.sakana.ai)';
  } catch (e) {
    fuguError = e instanceof Error ? e.message : 'fetch error';
  }
  const fuguMs = Date.now() - fuguT0;

  const wfT0 = Date.now();
  let waterfallText: string | null = null;
  let waterfallError: string | null = null;
  try {
    waterfallText = (await callAIFast(messages))?.trim() ?? null;
    if (waterfallText === null) waterfallError = 'callAIFast вернул null';
  } catch (e) {
    waterfallError = e instanceof Error ? e.message : 'fetch error';
  }
  const waterfallMs = Date.now() - wfT0;

  return NextResponse.json({
    title,
    fugu: {
      available: fuguText !== null,
      error: fuguError,
      duration_ms: fuguMs,
      length: fuguText?.length ?? 0,
      text: fuguText,
    },
    waterfall: {
      available: waterfallText !== null,
      error: waterfallError,
      duration_ms: waterfallMs,
      length: waterfallText?.length ?? 0,
      text: waterfallText,
    },
  });
}
