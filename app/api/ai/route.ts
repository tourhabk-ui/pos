import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter, getClientIp } from '@/lib/rate-limit'
import { callAIWaterfall } from '@/lib/ai/providers'
import { z } from 'zod'

export const runtime = 'nodejs'

const aiLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

// Принимаем prompt ИЛИ input (истор. совместимость); не-строки коэрсим,
// длинное обрезаем до 800 (не отвергаем — прежнее поведение).
const PromptSchema = z.object({
  prompt: z.preprocess(v => (v == null ? v : String(v).slice(0, 800)), z.string()).optional(),
  input: z.preprocess(v => (v == null ? v : String(v).slice(0, 800)), z.string()).optional(),
}).refine(v => !!(v.prompt?.trim() || v.input?.trim()), { message: 'EMPTY' })

// AUTH: Public — AI assistant for visitors
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers)
  if (!aiLimiter.check(ip)) {
    return NextResponse.json({ ok: false, error: 'Слишком много запросов. Попробуйте позже.' }, { status: 429 })
  }

  try {
    // Ветвимся по Content-Type: тело читается ровно один раз (неудачный
    // formData() у undici портит стрим — json() после него падает).
    // formData-поля — через .get() (раньше читались как свойства объекта
    // и терялись: form-отправки всегда получали EMPTY).
    const ct = req.headers.get('content-type') ?? '';
    const isForm = ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded');
    let body: unknown = null;
    if (isForm) {
      const fd = await req.formData().catch(() => null);
      if (fd) body = { prompt: fd.get('prompt') ?? undefined, input: fd.get('input') ?? undefined };
    } else {
      body = await req.json().catch(() => null);
    }

    const parsed = PromptSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'EMPTY' }, { status: 400 })
    const q = (parsed.data.prompt?.trim() ? parsed.data.prompt : parsed.data.input ?? '').slice(0, 800);

    const answer = await callAIWaterfall([
      { role: 'system', content: 'Кратко и по делу. Я туристический ассистент Камчатки.' },
      { role: 'user', content: q },
    ])

    return NextResponse.json({ ok: true, answer })
  } catch {
    return NextResponse.json({ ok: false, error: 'AI_FAILED' }, { status: 500 })
  }
}