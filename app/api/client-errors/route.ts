/**
 * POST /api/client-errors — приёмник ловушки ошибок браузера.
 *
 * Решение владельца 13.10: «ловушку». Страница присылает сюда необработанную
 * ошибку (lib/client-errors/report), приёмник чистит её и пишет строку в
 * client_errors (миграция 1236); суточная перепись client-errors-census
 * собирает группы и шлёт дайджест.
 *
 * Без авторизации (реестр публичных роутов), поэтому:
 *   - частота по IP: 30 докладов в минуту, дальше 429;
 *   - тело — только форма из схемы, лишнее отбрасывается на входе;
 *   - ПД: сообщение и стек чистятся (scrubErrorText), путь — без query и
 *     фрагмента; IP и User-Agent не хранятся — суточный visitor_hash как у
 *     page_views и род устройства/браузера одним словом;
 *   - бот и свой заход помечаются, не выбрасываются (как в page_views).
 *
 * Ответ 204: sendBeacon тело не читает. Отказ базы — 503 и строка в лог с
 * SQLSTATE (§4.0: «не записали» не выдаётся за «записали»).
 *
 * Сторож: tests/unit/client-errors-api.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { CLIENT_ERROR_KINDS, scrubErrorText, pathOnly, errorFingerprint, classifyUserAgent } from '@/lib/client-errors/scrub';

export const dynamic = 'force-dynamic';

const ReportSchema = z.object({
  kind: z.enum(CLIENT_ERROR_KINDS),
  message: z.string().min(1).max(1000),
  stack: z.string().max(4000).optional(),
  path: z.string().min(1).max(500),
  online: z.boolean().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});

export const RATE_LIMIT = { windowMs: 60_000, max: 30 } as const;
const limiter = createRateLimiter(RATE_LIMIT);

/**
 * Коммит сборки прода — из маркера деплоя public/version.json
 * (scripts/write-version.js). Нет маркера — NULL, и это известное состояние
 * (health отдаёт marker_missing), а не повод не принять ошибку.
 */
let buildCache: string | null | undefined;
function buildCommit(): string | null {
  if (buildCache !== undefined) return buildCache;
  try {
    const o = JSON.parse(readFileSync(join(process.cwd(), 'public', 'version.json'), 'utf8')) as { commit?: unknown };
    buildCache = typeof o.commit === 'string' && o.commit !== 'unknown' ? o.commit.slice(0, 40) : null;
  } catch {
    buildCache = null;
  }
  return buildCache;
}

/** Только для тестов: сбросить кэш маркера сборки. */
export function resetBuildCache(): void { buildCache = undefined; }

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ ok: false, error: 'Слишком много докладов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'Тело не JSON' }, { status: 400 }); }

  const parsed = ReportSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'Форма доклада не распознана' }, { status: 400 });

  const r = parsed.data;
  const userAgent = req.headers.get('user-agent') ?? '';
  const message = scrubErrorText(r.message, 1000) || '(пусто)';
  const stack = r.stack ? scrubErrorText(r.stack, 4000) : null;
  const path = pathOnly(r.path);
  const { device, browser } = classifyUserAgent(userAgent);
  const hash = visitorHash(ip, userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
  const occurredAt = r.occurred_at ? new Date(r.occurred_at) : null;

  try {
    await pool.query(
      `INSERT INTO client_errors
         (occurred_at, kind, message, stack, fingerprint, path, device, browser, online, build, visitor_hash, is_bot, is_self)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt.toISOString() : null,
        r.kind, message, stack,
        errorFingerprint(r.kind, message, stack),
        path, device, browser,
        r.online ?? null,
        buildCommit(),
        hash,
        isBotUserAgent(userAgent),
        isSelfVisit(req.headers.get('cookie')),
      ],
    );
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[client-errors] строка не записана:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ ok: false, error: 'Приёмник не смог записать' }, { status: 503 });
  }
  return new NextResponse(null, { status: 204 });
}
