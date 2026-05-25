import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter, getClientIp } from '@/lib/rate-limit'
import { callAIFast } from '@/lib/ai/providers'

export const runtime = 'nodejs'

const aiLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

// AUTH: Public — AI assistant for visitors
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers)
  if (!aiLimiter.check(ip)) {
    return NextResponse.json({ ok: false, error: 'Слишком много запросов. Попробуйте позже.' }, { status: 429 })
  }

  try {
    const body: unknown = await req.formData().catch(async () => await req.json().catch(() => null));
    const parsed = body as Record<string, unknown> | null;
    const raw = parsed?.prompt ?? parsed?.input ?? '';
    const q = String(raw).slice(0, 800);
    if (!q) return NextResponse.json({ error: 'EMPTY' }, { status: 400 })

    const answer = await callAIFast([
      { role: 'system', content: 'Кратко и по делу. Я туристический ассистент Камчатки.' },
      { role: 'user', content: q },
    ]).catch(() => null)

    return NextResponse.json({ ok: true, answer: answer ?? 'Сейчас не могу ответить. Попробуйте позже.' })
  } catch {
    return NextResponse.json({ ok: false, error: 'AI_FAILED' }, { status: 500 })
  }
}
