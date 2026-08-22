/**
 * lib/safety/alerts.ts — предупреждения по зонам, заводимые человеком.
 *
 * Таблицу `safety_alerts` завела миграция 065 со словами в собственной шапке:
 * «Admins create alerts per zone; planner surfaces them in recommendations».
 * Половина обещания не выполнялась ни дня: 22.08.2026 перепись нашла у таблицы
 * РОВНО ОДНОГО потребителя — `SELECT` в планировщике (`lib/planner/engine.ts`),
 * и НИ ОДНОГО пишущего. Ни API, ни экрана, ни скрипта. Администратор не мог
 * завести предупреждение никаким способом.
 *
 * Обнаружилось это на живом случае: пришло сообщение о временном ограничении
 * посещения природного парка «Ключевской» — паводок на реке Студёной, размыта
 * подъездная дорога, сквозной проезд перекрыт. Донести это до туриста платформе
 * было нечем, хотя таблица под это существует четвёртый месяц.
 *
 * Здесь — запись и чтение. Зоны и уровни повторяют CHECK-ограничения миграции
 * 065: разойтись им нельзя, поэтому списки объявлены один раз и сверяются
 * сторожем `tests/unit/safety-alerts-writable.test.ts`.
 */

import { z } from 'zod';
import { pool } from '@/lib/db-pool';

/** Зоны из CHECK миграции 065. `all` — вся Камчатка. */
export const ALERT_ZONES = ['avachinsky', 'western', 'eastern', 'northern', 'all'] as const;
export type AlertZone = typeof ALERT_ZONES[number];

export const ALERT_SEVERITIES = ['critical', 'important', 'info'] as const;
export type AlertSeverity = typeof ALERT_SEVERITIES[number];

export const ZONE_LABELS: Record<AlertZone, string> = {
  avachinsky: 'Авачинская группа',
  northern: 'Северная Камчатка',
  eastern: 'Восточная Камчатка',
  western: 'Западная Камчатка',
  all: 'Вся Камчатка',
};

export const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: 'Критично',
  important: 'Важно',
  info: 'Информация',
};

export interface SafetyAlert {
  id: string;
  zone: AlertZone;
  severity: AlertSeverity;
  title: string;
  message: string;
  source: string;
  active_from: string;
  active_until: string | null;
  is_active: boolean;
  created_at: string;
}

/**
 * Вход формы. Длины — из миграции (title 200, source 100), обрезать молча
 * нельзя: обрезанный заголовок предупреждения меняет смысл.
 */
export const alertInputSchema = z.object({
  zone: z.enum(ALERT_ZONES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string().trim().min(5, 'Заголовок слишком короткий').max(200, 'Заголовок длиннее 200 символов'),
  message: z.string().trim().min(10, 'Опишите ограничение подробнее').max(4000),
  /**
   * Кто сказал. Обязателен и без умолчания: предупреждение без источника
   * через день неотличимо от слуха, а решение по нему принимает человек в
   * поле. Умолчание «МЧС Камчатка» было бы приписыванием чужих слов.
   */
  source: z.string().trim().min(3, 'Назовите источник').max(100),
  /**
   * Когда перестаёт действовать. Поле ОБЯЗАТЕЛЬНО, `null` — законный ответ
   * «срок неизвестен, снимем вручную». Умолчания нет намеренно: «до какого
   * числа это верно» надо сказать вслух, а не забыть (§4.0).
   */
  active_until: z.string().datetime({ offset: true }).nullable(),
});

export type AlertInput = z.infer<typeof alertInputSchema>;

export async function createAlert(input: AlertInput, createdBy: string | null): Promise<SafetyAlert> {
  const { rows } = await pool.query<SafetyAlert>(
    `INSERT INTO safety_alerts (zone, severity, title, message, source, active_until, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
     RETURNING id, zone, severity, title, message, source,
               active_from, active_until, is_active, created_at`,
    [input.zone, input.severity, input.title, input.message, input.source,
     input.active_until ?? null, createdBy],
  );
  return rows[0];
}

/**
 * Снять предупреждение. Не удаляем: снятое ограничение — такой же факт, как
 * введённое, и по нему потом восстанавливают, что и когда было закрыто.
 *
 * Причина снятия обязательна и дописывается в текст. Отдельной колонки под неё
 * в миграции 065 нет, а заводить схему ради одной строки в разгар сведения двух
 * приёмников — лишний риск; текст снятого предупреждения туристу уже не
 * показывается, так что дописка никого не путает. Колонку стоит завести, когда
 * до `safety_alerts` дойдут руками.
 */
export async function deactivateAlert(id: string, reason: string): Promise<{ id: string; title: string } | null> {
  const { rows } = await pool.query<{ id: string; title: string }>(
    `UPDATE safety_alerts
        SET is_active = FALSE,
            message = message || E'\\n\\n[снято: ' || $2 || ']'
      WHERE id = $1::uuid AND is_active = TRUE
    RETURNING id::text, title`,
    [id, reason],
  );
  return rows[0] ?? null;
}

export async function listAlerts(includeInactive = false): Promise<SafetyAlert[]> {
  const { rows } = await pool.query<SafetyAlert>(
    `SELECT id, zone, severity, title, message, source,
            active_from, active_until, is_active, created_at
     FROM safety_alerts
     ${includeInactive ? '' : 'WHERE is_active = TRUE'}
     ORDER BY is_active DESC, severity = 'critical' DESC, created_at DESC
     LIMIT 200`,
  );
  return rows;
}

/**
 * Действующие предупреждения для зоны — то, что видит турист на карточке
 * маршрута и тура. `all` попадает в любую зону.
 *
 * Отказ запроса НЕ глушится в «предупреждений нет» (§4.0): вызывающий обязан
 * различать «чисто» и «не смог спросить». Здесь исключение пробрасывается.
 */
export async function activeAlertsForZone(zone: string | null): Promise<SafetyAlert[]> {
  const { rows } = await pool.query<SafetyAlert>(
    `SELECT id, zone, severity, title, message, source,
            active_from, active_until, is_active, created_at
     FROM safety_alerts
     WHERE is_active = TRUE
       AND (zone = $1 OR zone = 'all')
       AND active_from <= NOW()
       AND (active_until IS NULL OR active_until > NOW())
     ORDER BY severity = 'critical' DESC, created_at DESC
     LIMIT 10`,
    [zone ?? 'all'],
  );
  return rows;
}
