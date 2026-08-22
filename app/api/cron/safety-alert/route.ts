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
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import {
  ALERT_ZONES, ALERT_SEVERITIES, alertInputSchema,
  createAlert, deactivateAlert, listAlerts,
} from '@/lib/safety/alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Зоны, уровни и правила приёма — из lib/safety/alerts.ts. Своих здесь нет
// намеренно: 23.08 у таблицы появились ДВА приёмника разом (этот и админский
// экран), каждый со своей проверкой. Две проверки одного — это две разные
// правды о том, что считается допустимым предупреждением, и расходятся они
// молча. Домен один, входов может быть сколько угодно.
export { ALERT_ZONES, ALERT_SEVERITIES };

const PublishSchema = alertInputSchema.extend({ action: z.literal('publish') });

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
    const items = await listAlerts();
    return NextResponse.json({
      success: true, probe: 'safety_alert_v1', total: items.length, items,
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
      const removed = await deactivateAlert(d.id, d.reason);
      if (removed === null) {
        // Не «сняли» — либо нет такого, либо уже снято. Это разные вещи для
        // человека, и обе не равны успеху.
        return NextResponse.json(
          { success: false, error: 'Предупреждение не найдено или уже снято' },
          { status: 404 },
        );
      }
      return NextResponse.json({
        success: true, probe: 'safety_alert_v1', deactivated: removed.id, title: removed.title,
      });
    }

    // created_by здесь null: запрос принесён по CRON_SECRET, конкретного
    // пользователя за ним нет, и выдумывать его нельзя.
    const created = await createAlert(d, null);
    return NextResponse.json({
      success: true,
      probe: 'safety_alert_v1',
      created: created.id,
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
