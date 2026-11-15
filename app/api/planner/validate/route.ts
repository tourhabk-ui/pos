/**
 * POST /api/planner/validate
 *
 * Real route validation using zone graph, activity constraints, and seasonal data.
 * Returns structured issues with severity levels.
 */

import { NextRequest, NextResponse } from 'next/server';
import { plannerSession } from '@/lib/planner/require-session';
import { z } from 'zod';
import {
  ZONE_GRAPH,
  ACTIVITY_CONSTRAINTS,
  ZONE_ALLOWED_TRANSPORT,
} from '@/lib/planner/engine';
import type { ZoneId } from '@/lib/planner/engine';
import { ACTIVITY_NAMES, ZONE_NAMES } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { monthOfIsoDate, MONTH_IN } from '@/lib/planner/trip-season';
import { SEASON_BLOCKED } from '@/lib/planner/interests';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Публичный на Edge POST без рубежа — соседние /api/planner/* давно за
// лимитером, этот оставался открытым.
const validateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const DaySchema = z.object({
  // Номер дня — целый, в пределах года: огромное число роняло проверку в 500
  // на дате дня (ревью безопасности #3383).
  day:              z.number().int().min(1).max(366),
  /** Тип дня (arrival, activity, travel, rest, buffer, departure); старый клиент его не шлёт. */
  type:             z.string().max(20).optional(),
  zone:             z.enum(['avachinsky', 'western', 'eastern', 'northern']),
  title:            z.string(),
  activityType:     z.string(),
  defaultTransport: z.string(),
});

const BodySchema = z.object({
  // 60, как у сохранённой поездки: план длиннее 21 дня молча не проверялся (400).
  days:         z.array(DaySchema).min(2).max(60),
  arrivalDate:  z.string().date().optional(),
  fitnessLevel: z.enum(['beginner', 'moderate', 'active']).optional(),
  seasickness:  z.boolean().optional(),
  children:     z.array(z.number().min(0).max(17)).optional(),
});

interface ValidationIssue {
  type: string;
  severity: 'critical' | 'important' | 'info';
  message: string;
  day?: number;
}

const FITNESS_ORDER: Record<string, number> = {
  beginner: 0, moderate: 1, active: 2,
};

// Слова человеку — по-русски (разбор планера 14.11, экран-5): ответ писал
// «активность "bears"», «avachinsky -> eastern», «уровень "active"».
const FITNESS_WORDS: Record<string, string> = { beginner: 'начальная', moderate: 'средняя', active: 'хорошая' };
const TRANSPORT_WORDS: Record<string, string> = { walking: 'пешком', jeep: 'внедорожник', helicopter: 'вертолёт', boat: 'катер' };
const activityWord = (a: string) => ACTIVITY_NAMES[a] ?? a;
const zoneWord = (z: string) => ZONE_NAMES[z as ZoneId] ?? z;

/** Не занятие: прилёт, переезд, отдых, резерв, отъезд — по типу дня, а без него по виду. */
function isActive(d: z.infer<typeof DaySchema>): boolean {
  if (d.type) return d.type === 'activity';
  return Boolean(d.activityType) && !['rest', 'travel', 'departure'].includes(d.activityType);
}

export async function POST(req: NextRequest) {
  // Только после входа (слово владельца 14.11 «6-3»): lib/planner/require-session.
  const session = await plannerSession(req);
  if (session instanceof NextResponse) return session;
  if (!validateLimiter.check(getClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные данные', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { days, arrivalDate, fitnessLevel, seasickness, children } = parsed.data;
  const issues: ValidationIssue[] = [];

  // 1. Must have at least one activity
  const hasActivities = days.some(isActive);
  if (!hasActivities) {
    issues.push({
      type: 'no_activities',
      severity: 'critical',
      message: 'Добавьте хотя бы одну активность на маршрут.',
    });
  }

  // 2. Zone transitions — check if travel day is needed
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const curr = days[i];
    if (prev.zone !== curr.zone) {
      const edge = ZONE_GRAPH[prev.zone as ZoneId]?.[curr.zone as ZoneId];
      if (edge?.needsTravelDay) {
        // Check if there's a travel/rest day between these activity days
        // День переезда сам и есть переезд: до 14.11 он считался занятием, и
        // план движка «переезд → медведи» получал «нужен переезд».
        if (isActive(prev) && isActive(curr)) {
          const hours = edge.travelHours ? `${edge.travelHours} ч` : 'вертолёт';
          issues.push({
            type: 'missing_travel_day',
            severity: 'important',
            message: `Между днями ${prev.day} и ${curr.day} нужен переезд (${zoneWord(prev.zone)} → ${zoneWord(curr.zone)}, ${edge.distanceKm} км, ${hours}). Добавьте день переезда.`,
            day: curr.day,
          });
        }
      }
    }
  }

  // 3. Seasonal checks
  if (arrivalDate) {
    for (const d of days) {
      if (!isActive(d)) continue;
      // Месяц ЭТОГО дня, а не прилёта, и без часового пояса (разбор 14.11).
      const arrMonth = monthOfIsoDate(dateOfTripDay(arrivalDate, d.day));
      if (arrMonth === null) continue;

      // Check SEASON_BLOCKED
      const blocked = SEASON_BLOCKED[arrMonth] ?? [];
      if (blocked.includes(d.activityType)) {
        issues.push({
          type: 'seasonal_block',
          severity: 'critical',
          message: `${d.title} (день ${d.day}): в ${MONTH_IN[arrMonth - 1]} недоступно.`,
          day: d.day,
        });
      }

      // Check ACTIVITY_CONSTRAINTS.months
      const constraint = ACTIVITY_CONSTRAINTS[d.activityType];
      if (constraint?.months && !constraint.months.includes(arrMonth)) {
        // Avoid duplicate if already caught by SEASON_BLOCKED
        const alreadyCaught = issues.some(
          iss => iss.day === d.day && iss.type === 'seasonal_block',
        );
        if (!alreadyCaught) {
          issues.push({
            type: 'out_of_season',
            severity: 'critical',
            message: `${d.title} (день ${d.day}): ${activityWord(d.activityType)} — по нашему сезонному ориентиру не в ${MONTH_IN[arrMonth - 1]}.`,
            day: d.day,
          });
        }
      }
    }
  }

  // 4. Activity-zone compatibility
  for (const d of days) {
    if (!isActive(d)) continue;
    const constraint = ACTIVITY_CONSTRAINTS[d.activityType];
    if (constraint?.bestZones && !constraint.bestZones.includes(d.zone as ZoneId)) {
      issues.push({
        type: 'zone_mismatch',
        severity: 'info',
        message: `${d.title} (день ${d.day}): ${activityWord(d.activityType)} — обычно в зонах: ${constraint.bestZones.map(zoneWord).join(', ')}.`,
        day: d.day,
      });
    }
  }

  // 5. Transport feasibility
  for (const d of days) {
    if (!d.defaultTransport || !isActive(d)) continue;
    const allowed = ZONE_ALLOWED_TRANSPORT[d.zone as ZoneId];
    if (allowed && !allowed.includes(d.defaultTransport as 'walking' | 'jeep' | 'helicopter' | 'boat')) {
      issues.push({
        type: 'invalid_transport',
        severity: 'important',
        message: `День ${d.day}: ${TRANSPORT_WORDS[d.defaultTransport] ?? d.defaultTransport} недоступен в зоне «${zoneWord(d.zone)}».`,
        day: d.day,
      });
    }
  }

  // 6. Child age constraints
  if (children && children.length > 0) {
    const minChildAge = Math.min(...children);
    for (const d of days) {
      if (!isActive(d)) continue;
      const constraint = ACTIVITY_CONSTRAINTS[d.activityType];
      if (constraint?.minChildAge && minChildAge < constraint.minChildAge) {
        issues.push({
          type: 'child_age',
          severity: 'important',
          message: `День ${d.day}: ${activityWord(d.activityType)} — детям от ${constraint.minChildAge} лет (младшему ${minChildAge}).`,
          day: d.day,
        });
      }
    }
  }

  // 7. Fitness level check
  if (fitnessLevel) {
    const userFitness = FITNESS_ORDER[fitnessLevel] ?? 0;
    for (const d of days) {
      if (!isActive(d)) continue;
      const constraint = ACTIVITY_CONSTRAINTS[d.activityType];
      if (constraint?.fitnessRequired) {
        const reqFitness = FITNESS_ORDER[constraint.fitnessRequired] ?? 0;
        if (userFitness < reqFitness) {
          issues.push({
            type: 'fitness_mismatch',
            severity: 'info',
            message: `День ${d.day}: ${activityWord(d.activityType)} — нужна ${FITNESS_WORDS[constraint.fitnessRequired] ?? constraint.fitnessRequired} подготовка, у вас ${FITNESS_WORDS[fitnessLevel] ?? fitnessLevel}.`,
            day: d.day,
          });
        }
      }
    }
  }

  // 8. Seasickness warning
  if (seasickness) {
    const seaActivities = new Set(['boat_trip', 'sea', 'fishing']);
    for (const d of days) {
      if (isActive(d) && seaActivities.has(d.activityType)) {
        issues.push({
          type: 'seasickness',
          severity: 'info',
          message: `День ${d.day}: ${activityWord(d.activityType)} — выход на воду. При укачивании возьмите препараты.`,
          day: d.day,
        });
      }
    }
  }

  const hasCritical = issues.some(i => i.severity === 'critical');
  const valid = !hasCritical;

  let message: string;
  if (!valid) {
    const critCount = issues.filter(i => i.severity === 'critical').length;
    // Брони через план нет — есть заявка (разбор 14.11, экран-5).
    message = `Обнаружены проблемы (${critCount} критических). Исправьте их перед заявкой.`;
  } else if (issues.length > 0) {
    message = `Критичных замечаний нет, рекомендаций: ${issues.length}.`;
  } else {
    message = 'Критичных замечаний нет.';
  }

  return NextResponse.json({ success: true, valid, message, issues });
}
