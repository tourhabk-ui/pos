/**
 * GET /api/cron/scout-study?url=...&q=...  — разведчик изучает названный источник.
 *
 * Ручной инструмент: человек (или другой агент) даёт адрес и вопрос, прод
 * читает источник и отвечает ТОЛЬКО из прочитанного, с цитатами.
 *
 * ── Почему это живёт на проде, а не у разработчика ───────────────────────
 *
 * 29.08: понадобились частоты LoRa-региона RU с meshtastic.org. Рабочая
 * среда разработчика закрывает часть доменов egress-политикой организации,
 * прод — нет. Ответ тогда добыли поиском, и в MESH.md он лёг с пометкой
 * «глазами не читан». Этот роут закрывает разрыв: читает прод, отвечает
 * первоисточник, а не пересказ.
 *
 * ── Три исхода, не два (§4.0) ────────────────────────────────────────────
 *
 *   answered      — прочитали, ответ есть, цитаты приложены;
 *   not_in_source — прочитали, нужного там нет (факт об источнике);
 *   failed        — прочитать или разобрать не смогли (причина названа).
 *
 * Смешивать второе с третьим запрещено: «источник молчит» и «мы не смогли»
 * ведут к разным действиям, и именно на этой подмене разведчик уже стоял
 * двадцать один день (см. шапку scout-diagnose).
 *
 * Сеть — только через safeFetchText: адрес и КАЖДЫЙ редирект судятся заново
 * (SSRF), приватные адреса недостижимы.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { callAIFastOrNull } from '@/lib/ai/providers';
import { KnowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { safeFetchText } from '@/lib/agents/scout-fetch';
import {
  buildStudyMessages, parseStudyVerdict, describeOutcome, sourceHtmlToText,
} from '@/lib/agents/scout-study';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const QuerySchema = z.object({
  url: z.string().url('url должен быть полным адресом http(s)'),
  q: z.string().min(5, 'вопрос слишком короткий').max(500, 'вопрос длиннее 500 символов'),
  // Сохранять ли находку в память агентов. По умолчанию нет: разовая
  // справка не должна засорять базу знаний.
  save: z.enum(['0', '1']).optional(),
});

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse({
    url: request.nextUrl.searchParams.get('url') ?? undefined,
    q: request.nextUrl.searchParams.get('q') ?? undefined,
    save: request.nextUrl.searchParams.get('save') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' },
      { status: 400 },
    );
  }
  const { url, q: question, save } = parsed.data;

  // 1. Прочитать источник
  const fetched = await safeFetchText(url);
  if (!fetched.ok) {
    return NextResponse.json({
      success: true,
      probe: 'scout_study_v1',
      source: url,
      question,
      outcome: 'failed',
      summary: `не смог: ${fetched.reason}`,
      reason: fetched.reason,
    });
  }

  const text = sourceHtmlToText(fetched.body);
  if (text.length < 200) {
    // Страница ответила, но читать нечего: обычно JS-рендеринг или заглушка.
    // Это «не смог», а не «в источнике нет» — мы просто не увидели содержимое.
    return NextResponse.json({
      success: true,
      probe: 'scout_study_v1',
      source: url,
      final_url: fetched.finalUrl,
      question,
      outcome: 'failed',
      summary: `не смог: со страницы снялось ${text.length} символов текста (вероятно, содержимое рисует JS)`,
      reason: 'too_little_text',
    });
  }

  // 2. Спросить модель строго по тексту
  const raw = await callAIFastOrNull(buildStudyMessages(url, question, text));
  const outcome = parseStudyVerdict(raw);
  const summary = describeOutcome(outcome);

  // 3. Сохранить, если попросили и есть что сохранять
  let savedSlug: string | null = null;
  if (save === '1' && outcome.kind === 'answered') {
    try {
      const host = new URL(fetched.finalUrl).hostname.replace(/^www\./, '');
      const slug = `intel/study/${host}/${Date.now()}`;
      const page = await new KnowledgeBase().upsert({
        slug,
        type: 'intel',
        title: `Изучение источника: ${host}`,
        compiled_truth: [
          `Вопрос: ${question}`,
          `Источник: ${fetched.finalUrl}`,
          '',
          outcome.answer,
          '',
          'Цитаты из источника:',
          ...outcome.quotes.map(c => `— ${c}`),
        ].join('\n'),
        metadata: {
          source_url: fetched.finalUrl,
          question,
          quotes: outcome.quotes,
          studied_at: new Date().toISOString(),
        },
        agent_id: 'scout',
      });
      savedSlug = page?.slug ?? null;
      if (!savedSlug) {
        console.error('[scout-study] находка не сохранилась: upsert вернул null');
      }
    } catch (err) {
      // Сбой сохранения не отменяет добытого ответа — он уже в теле ответа.
      console.error('[scout-study] сохранение находки упало:', err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    success: true,
    probe: 'scout_study_v1',
    source: url,
    final_url: fetched.finalUrl,
    question,
    outcome: outcome.kind,
    summary,
    chars_read: text.length,
    truncated: fetched.truncated,
    ...(outcome.kind === 'answered'
      ? { answer: outcome.answer, quotes: outcome.quotes }
      : {}),
    ...(outcome.kind === 'not_in_source' ? { missing: outcome.note } : {}),
    ...(outcome.kind === 'failed' ? { reason: outcome.reason } : {}),
    saved_slug: savedSlug,
  });
}
