/**
 * GET /api/cron/translation-probe            — список случаев пробы (модель не зовётся)
 * GET /api/cron/translation-probe?case=<имя> — один случай: исход, причина, перевод, время
 * Authorization: Bearer <CRON_SECRET>
 *
 * Живая проба машинного перевода с прода (13.11): успевает ли модель в срок
 * переписки заявки и принимает ли сверка то, что она пишет на деле. Зачем и
 * чем — в `lib/ai/translation-probe`.
 *
 * Только чтение: в базу не пишет, людям ничего не шлёт. Модель зовёт — один
 * раз на вызов с `case`; расход подписан `translation-probe`. Тексты пробы
 * постоянные и придуманные: из запроса приходит только ИМЯ случая, текст для
 * модели из запроса не берётся — переводчиком произвольного текста этот адрес
 * не служит.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { withSpendAgent } from '@/lib/ai/usage-context';
import { CHAT_TRANSLATE_TIMEOUT_MS } from '@/lib/requests/chat-translation';
import { PROBE_CASE_TIMEOUT_MS, TRANSLATION_PROBE_CASES, probeCase, runTranslationProbe } from '@/lib/ai/translation-probe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Подпись расхода — первым делом: всё, что внутри зовёт модель, ложится в
  // книги под этим именем (сторож cron-spend-signed).
  return withSpendAgent('translation-probe', async () => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }
    if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const cases = TRANSLATION_PROBE_CASES.map((c) => c.name);
    const name = request.nextUrl.searchParams.get('case');
    if (name === null) {
      return NextResponse.json({
        success: true,
        note: 'Случай не назван — модель не звалась. Один вызов с ?case=<имя> — один случай.',
        cases, chat_limit_ms: CHAT_TRANSLATE_TIMEOUT_MS, case_timeout_ms: PROBE_CASE_TIMEOUT_MS,
      });
    }
    const found = probeCase(name);
    if (!found) {
      return NextResponse.json({ success: false, error: 'Такого случая пробы нет', cases }, { status: 400 });
    }
    const row = await runTranslationProbe(found);
    return NextResponse.json({ success: true, ...row });
  });
}
