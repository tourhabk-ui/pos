import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { callAIWaterfall } from '@/lib/ai/providers';

export const runtime = 'edge';

const deepseekLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const DeepSeekChatSchema = z.object({
  message: z.string().min(1, 'Сообщение обязательно'),
  context: z.string().optional(),
});

// POST /api/ai/deepseek - Chat с DeepSeek AI
// AUTH: Public — AI assistant for visitors
export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!deepseekLimiter.check(ip)) {
    return NextResponse.json(
      { error: 'Слишком много запросов. Попробуйте позже.' },
      { status: 429 }
    );
  }
  try {
    const body = await request.json();
    const parsed = DeepSeekChatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' },
        { status: 400 }
      );
    }
    const { message } = parsed.data;

    const systemPrompt = `Ты AI.Kam - умный помощник по Камчатке.

Твоя роль:
- Помогать туристам узнать о Камчатке
- Рекомендовать туры, достопримечательности, активности
- Давать советы по безопасности и подготовке
- Отвечать на вопросы о погоде, транспорте, размещении
- Быть дружелюбным и информативным

Информация о Камчатке:
- Вулканы: Авачинский (2741м), Корякский (3456м), Мутновский, Толбачик
- Долина гейзеров - уникальное место с 90+ гейзерами
- Курильское озеро - место нереста лосося и обитания медведей
- Халактырский пляж - черный вулканический песок
- Лучшее время: июль-сентябрь
- Рыбалка: лосось, кижуч, чавыча, голец
- Горячие источники: Паратунка, Верхне-Паратунские

Отвечай кратко, по-русски, с эмодзи для наглядности.`;

    const aiMessage = await callAIWaterfall([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ]);

    return NextResponse.json({
      success: true,
      data: {
        message: aiMessage,
      },
    });

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// GET /api/ai/deepseek/status - Проверка статуса API
export async function GET(_request: NextRequest) {
  return NextResponse.json({
    success: true,
    data: {
      configured: true,
      model: 'waterfall',
    },
  });
}
