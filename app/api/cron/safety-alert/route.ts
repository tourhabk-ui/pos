/**
 * Предупреждение безопасности: приёмник.
 *
 * ── Почему он появился только сейчас ───────────────────────────────────────
 *
 * 23.08.2026 туристы не могут выехать с территории парка «Вулканы Камчатки»:
 * проезд перекрыт, вывоз авиацией ночью ограничен, работы начинают с утра.
 * Владелец прислал сводку — и выяснилось, что положить её платформе НЕКУДА.
 *
 * Таблица `safety_alerts` заведена миграцией 065. Её ЧИТАЮТ: планировщик
 * подмешивает предупреждения в рекомендации (lib/planner/engine.ts), их
 * показывает разбор маршрутов. Не пишет её НИКТО: ни ручка, ни админка, ни
 * крон. С момента создания она пуста.
 *
 * То есть слой предупреждений выглядел работающим и был мёртв: планировщик
 * каждый раз спрашивал «что опасного в этой зоне», получал пустой список и
 * рекомендовал маршруты так, будто ничего не случилось. Ровно тот же
 * механизм, что весь день: отсутствие ответа неотличимо от ответа «всё
 * спокойно». Только здесь цена — не молчащий дайджест, а человек, которого
 * платформа отправила туда, откуда сейчас не выехать.
 *
 * ── Правила ────────────────────────────────────────────────────────────────
 *
 * `source` обязателен: предупреждение без источника через день неотличимо от
 * слуха, а решение по нему принимает человек в поле.
 *
 * `active_until` обязателен как ПОЛЕ, но `null` — законное значение: «срок
 * неизвестен, снимем вручную». Умолчания нет намеренно — «до какого числа
 * это верно» надо сказать вслух, а не забыть (§4.0).
 *
 * Снятие — отдельным действием, а не удалением строки: история предупреждений
 * это история решений, и стирать её нельзя.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Зоны — из CHECK миграции 065. Своих не выдумываем. */
export const ALERT_ZONES = ['avachinsky', 'western', 'eastern', 'northern', 'all'] as const;
export const ALERT_SEVERITIES = ['critical', 'important', 'info'] as const;

const PublishSchema = z.object({
  action: z.literal('publish'),
  zone: z.enum(ALERT_ZONES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string().trim().min(5).max(200),
  message: z.string().trim().min(10).max(4000),
  /** Кто сказал. Предупреждение без источника — слух. */
  source: z.string().trim().min(3).max(100),
  /** ISO-время или null — «снимем вручную». Умолчания нет: срок говорят вслух. */
  active_until: z.string().datetime().nullable(),
});

const DeactivateSchema = z.object({
  action: z.literal('deactivate'),
  id: z.string().uuid(),
  /** Почему сняли — в историю решений. */
  reason: z.string().trim().min(3).max(200),
});

const Schema = z.discriminatedUnion('action', [PublishSchema, DeactivateSchema]);

function unauthorized(request: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/** Что сейчас висит. Без этого нельзя понять, надо ли снимать. */
export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const { rows } = await pool.query(
      `SELECT id::text, zone, severity, title, message, source,
              active_from, active_until, is_active
         FROM safety_alerts
        WHERE is_active = TRUE
        ORDER BY severity = 'critical' DESC, active_from DESC
        LIMIT 50`,
    );
    return NextResponse.json({
      success: true, probe: 'safety_alert_v1', total: rows.length, items: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения предупреждений';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Тело запроса не разобрано' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'тело запроса';
    return NextResponse.json(
      {
        success: false,
        error: `Не принято поле «${field}»: ${issue?.message ?? 'некорректное значение'}. ` +
               `Публикация: action=publish, zone (${ALERT_ZONES.join('|')}), severity ` +
               `(${ALERT_SEVERITIES.join('|')}), title, message, source, active_until (ISO или null). ` +
               `Снятие: action=deactivate, id, reason.`,
      },
      { status: 400 },
    );
  }

  const d = parsed.data;
  try {
    if (d.action === 'deactivate') {
      const { rows } = await pool.query<{ id: string; title: string }>(
        `UPDATE safety_alerts
            SET is_active = FALSE,
                message = message || E'\\n\\n[снято: ' || $2 || ']'
          WHERE id = $1::uuid AND is_active = TRUE
        RETURNING id::text, title`,
        [d.id, d.reason],
      );
      if (rows.length === 0) {
        // Не «сняли» — либо нет такого, либо уже снято. Это разные вещи для
        // человека, и обе не равны успеху.
        return NextResponse.json(
          { success: false, error: 'Предупреждение не найдено или уже снято' },
          { status: 404 },
        );
      }
      return NextResponse.json({
        success: true, probe: 'safety_alert_v1', deactivated: rows[0].id, title: rows[0].title,
      });
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO safety_alerts (zone, severity, title, message, source, active_until)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       RETURNING id::text`,
      [d.zone, d.severity, d.title, d.message, d.source, d.active_until],
    );
    return NextResponse.json({
      success: true,
      probe: 'safety_alert_v1',
      created: rows[0].id,
      zone: d.zone,
      severity: d.severity,
      // Названо вслух: бессрочное предупреждение снимает человек, и об этом
      // надо помнить, а не обнаружить через месяц.
      until: d.active_until ?? 'до ручного снятия',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи предупреждения';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
