/**
 * Разведка от человека → эволюция.
 *
 * Владелец 23.08: «нужно в эволюцию разведку добавить». Повод конкретный —
 * он прислал новость про FreeToken (запуск больших MoE-моделей на своём
 * железе), и это ровно та находка, которую платформе полагалось принести
 * самой: у неё для этого есть Scout и мост intel-bridge. Scout молчит
 * двадцать первый день, поэтому новость пришла руками.
 *
 * Отсюда правило: у разведки должен быть ВТОРОЙ вход. Единственный автомат,
 * который умеет ломаться молча, — это отсутствие входа, а не наличие.
 *
 * Находка ложится тем же путём, что и машинная: категория `intel`, статус
 * `suggested`, дальше issue-reporter выносит её в GitHub Issues, и решение
 * остаётся за человеком. Дедуп — по ТЕМЕ (intelSignature), тот же, что у
 * моста: пересказ той же новости другими словами второй issue не заведёт.
 *
 * ── Чего здесь нельзя ──────────────────────────────────────────────────────
 *
 * Находка обязана нести ПРОИСХОЖДЕНИЕ и меру доверия. Пересказ в чате и
 * прочитанная статья — разные вещи, а через неделю в базе они выглядят
 * одинаково: «платформа знает». Сегодня цена такой подмены уже измерена —
 * алерт три недели советовал чинить промпт при вопросе, которого никто не
 * видел. Поэтому `source` и `checked` обязательны, умолчания у них нет, и
 * «не проверял» — законный ответ, а не пропуск поля (§4.0).
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { intelSignature } from '@/lib/agents/evo/claim-signature';
import { scrubInjectionLines } from '@/lib/agents/evo/memory-guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Schema = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(10).max(4000),
  suggestion: z.string().trim().min(10).max(2000),
  /** Откуда это. Находка без происхождения через неделю неотличима от выдумки. */
  source: z.string().trim().min(3).max(500),
  /**
   * Проверял ли отправитель первоисточник САМ.
   *
   * Умолчания нет намеренно. «Не проверял» — честный ответ и не мешает завести
   * находку; молча выдать пересказ за проверенный факт — мешает всему.
   */
  checked: z.enum(['verified', 'unverified']),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
});

const TRUST_LABEL: Record<'verified' | 'unverified', string> = {
  verified: 'первоисточник проверен отправителем',
  unverified: 'ПЕРВОИСТОЧНИК НЕ ПРОВЕРЕН — цифры и утверждения идут из пересказа',
};

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Тело запроса не разобрано' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Нужны title, description, suggestion, source и checks (verified|unverified)',
        details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  const d = parsed.data;
  // Текст приходит извне: чистим строки, похожие на инструкции модели, — тем
  // же средством, что и мост. Находку потом читает LLM разбора.
  const title = scrubInjectionLines(d.title);
  const suggestion = scrubInjectionLines(d.suggestion);
  const description = [
    scrubInjectionLines(d.description),
    '',
    `Источник: ${scrubInjectionLines(d.source)}`,
    `Достоверность: ${TRUST_LABEL[d.checked]}`,
    'Внесено человеком через /api/cron/intel-note (Scout молчит с 01.08).',
  ].join('\n');

  try {
    const sig = intelSignature({ title, description, suggestion });

    // Дедуп по теме среди ЖИВЫХ находок: перефразированная новость не должна
    // заводить вторую issue. Отклонённые человеком тоже считаются — иначе
    // отказ обходится повторной отправкой.
    const { rows: existing } = await pool.query<{ id: string; title: string; description: string; suggestion: string; status: string }>(
      `SELECT id, title, description, suggestion, status
         FROM evo_growth_issues
        WHERE category = 'intel'
          AND status IN ('suggested', 'open', 'accepted', 'rejected')`,
    );
    const dup = existing.find(e => intelSignature(e) === sig);
    if (dup) {
      return NextResponse.json({
        success: true,
        probe: 'intel_note_v1',
        created: false,
        reason: 'duplicate_topic',
        existing_id: dup.id,
        existing_status: dup.status,
        signature: sig,
      });
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
       VALUES ('intel', $1, $2, $3, $4, 'suggested')
       RETURNING id`,
      [d.severity, title, description, suggestion],
    );

    return NextResponse.json({
      success: true,
      probe: 'intel_note_v1',
      created: true,
      id: rows[0].id,
      signature: sig,
      trust: d.checked,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи находки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
