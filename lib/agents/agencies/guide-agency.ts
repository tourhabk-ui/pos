/**
 * GuideAgency — агент для гидов.
 *
 * guide_schedule         — предстоящие назначения гида
 * guide_groups           — активные группы и количество туристов
 * guide_earnings         — сводка по заработку
 * guide_status           — combined: расписание + группы + заработок
 * guide_route_preflight  — pre-flight safety-чек маршрута перед выходом (issue #248)
 */

import { pool } from '@/lib/db-pool';
import type { AgentContext } from '../context-hub';
import { findRoutePreflightSafety } from '@/lib/services/route-preflight-safety';

// Фразы-триггеры pre-flight команды — снимаются с начала сообщения, остаток
// считается названием маршрута ("проверь маршрут Авачинский" → "Авачинский").
const PREFLIGHT_TRIGGERS = [
  'предполётная проверка маршрута', 'предполетная проверка маршрута',
  'предполётная проверка', 'предполетная проверка',
  'safety-чек маршрута', 'safety чек маршрута',
  'проверка маршрута перед выходом',
  'проверь маршрут', 'route preflight', 'чек маршрута',
];

/** Чистая функция — извлекает название маршрута из свободного текста команды гида. */
export function extractRouteQueryFromMessage(message: string): string {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  let rest = trimmed;

  for (const trigger of PREFLIGHT_TRIGGERS) {
    const idx = lower.indexOf(trigger);
    if (idx !== -1) {
      rest = trimmed.slice(idx + trigger.length);
      break;
    }
  }

  return rest.replace(/^[\s:\-—,]*(на|по|для)?[\s:\-—,]*/i, '').trim();
}

export interface AgencyResult {
  response: string;
  data?: Record<string, unknown>;
}

interface ScheduleRow {
  booking_id: string;
  tour_title: string;
  start_date: string;
  end_date: string | null;
  booked_slots: number;
  status: string;
}

interface GroupsRow {
  active_groups: string;
  total_tourists: string;
}

interface EarningsRow {
  completed_tours: string;
  estimated_earnings: string | null;
}

export class GuideAgency {
  async run(
    intent: string,
    context: AgentContext,
    _originalMessage: string
  ): Promise<AgencyResult> {
    switch (intent) {
      case 'guide_schedule':         return this.getSchedule(context);
      case 'guide_groups':           return this.getGroups(context);
      case 'guide_earnings':         return this.getEarnings(context);
      case 'guide_status':           return this.getStatus(context);
      case 'guide_route_preflight':  return this.getRoutePreflight(_originalMessage);
      default:
        return {
          response:
            'Доступные команды гида:\n' +
            '- расписание / мои туры\n' +
            '- мои группы\n' +
            '- мой заработок\n' +
            '- статус (всё сразу)\n' +
            '- проверь маршрут <название> (safety pre-flight)',
        };
    }
  }

  private async getSchedule(context: AgentContext): Promise<AgencyResult> {
    if (!context.user.userId) {
      return { response: 'Войдите в систему для доступа к расписанию.' };
    }

    try {
      const { rows } = await pool.query<ScheduleRow>(
        `SELECT
           b.id            AS booking_id,
           t.title         AS tour_title,
           td.start_date::text AS start_date,
           td.end_date::text   AS end_date,
           td.booked_slots,
           b.booking_status AS status
         FROM operator_bookings b
         JOIN operator_tours t        ON t.id = b.tour_id
         JOIN tour_departures td ON td.id = b.departure_id
         WHERE t.guide_id = $1
           AND b.booking_status = 'confirmed'
           AND td.start_date >= CURRENT_DATE
           AND b.deleted_at IS NULL
           AND t.deleted_at IS NULL
         ORDER BY td.start_date
         LIMIT 10`,
        [context.user.userId]
      );

      if (rows.length === 0) {
        return { response: 'Предстоящих назначений не найдено.' };
      }

      const lines = ['<b>Ваше расписание:</b>', ''];
      for (const r of rows) {
        const dates = r.end_date ? `${r.start_date} — ${r.end_date}` : r.start_date;
        lines.push(`${r.tour_title} | ${dates} | ${r.booked_slots} чел | ${r.status}`);
      }

      return { response: lines.join('\n'), data: { schedule: rows } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка запроса расписания';
      return { response: `Не удалось загрузить расписание: ${msg}` };
    }
  }

  private async getGroups(context: AgentContext): Promise<AgencyResult> {
    if (!context.user.userId) {
      return { response: 'Войдите в систему для доступа к группам.' };
    }

    try {
      const { rows } = await pool.query<GroupsRow>(
        `SELECT
           COUNT(DISTINCT b.id)::text         AS active_groups,
           COALESCE(SUM(td.booked_slots), 0)::text AS total_tourists
         FROM operator_bookings b
         JOIN operator_tours t        ON t.id = b.tour_id
         JOIN tour_departures td ON td.id = b.departure_id
         WHERE t.guide_id = $1
           AND b.booking_status = 'confirmed'
           AND td.start_date >= CURRENT_DATE
           AND b.deleted_at IS NULL
           AND t.deleted_at IS NULL`,
        [context.user.userId]
      );

      const r = rows[0] ?? { active_groups: '0', total_tourists: '0' };
      return {
        response: `<b>Активные группы:</b>\nГрупп: ${r.active_groups}\nТуристов: ${r.total_tourists}`,
        data: { active_groups: r.active_groups, total_tourists: r.total_tourists },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка запроса групп';
      return { response: `Не удалось загрузить группы: ${msg}` };
    }
  }

  private async getEarnings(context: AgentContext): Promise<AgencyResult> {
    if (!context.user.userId) {
      return { response: 'Войдите в систему для доступа к статистике заработка.' };
    }

    try {
      const { rows } = await pool.query<EarningsRow>(
        `SELECT
           COUNT(DISTINCT b.id)::text                                              AS completed_tours,
           SUM(COALESCE(td.price_override, t.base_price, 0) * td.booked_slots)::text AS estimated_earnings
         FROM operator_bookings b
         JOIN operator_tours t        ON t.id = b.tour_id
         JOIN tour_departures td ON td.id = b.departure_id
         WHERE t.guide_id = $1
           AND b.booking_status = 'confirmed'
           AND b.deleted_at IS NULL
           AND t.deleted_at IS NULL`,
        [context.user.userId]
      );

      const r = rows[0] ?? { completed_tours: '0', estimated_earnings: null };
      const fmt = (v: string | null) =>
        v ? `${Number(v).toLocaleString('ru-RU')} руб` : '0 руб';

      return {
        response: [
          '<b>Ваш заработок:</b>',
          `Туров подтверждено: ${r.completed_tours}`,
          `Оценочный заработок: ${fmt(r.estimated_earnings)}`,
        ].join('\n'),
        data: { completed_tours: r.completed_tours, estimated_earnings: r.estimated_earnings },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка запроса заработка';
      return { response: `Не удалось загрузить данные о заработке: ${msg}` };
    }
  }

  private async getStatus(context: AgentContext): Promise<AgencyResult> {
    const [schedule, groups, earnings] = await Promise.all([
      this.getSchedule(context),
      this.getGroups(context),
      this.getEarnings(context),
    ]);

    const parts = [schedule.response, '', groups.response, '', earnings.response];
    return {
      response: parts.join('\n'),
      data: {
        schedule: schedule.data,
        groups:   groups.data,
        earnings: earnings.data,
      },
    };
  }

  private async getRoutePreflight(message: string): Promise<AgencyResult> {
    const routeQuery = extractRouteQueryFromMessage(message);
    if (!routeQuery) {
      return { response: 'Укажите название маршрута для проверки, например: "проверь маршрут Авачинский вулкан".' };
    }

    try {
      const safety = await findRoutePreflightSafety(routeQuery);
      if (!safety) {
        return { response: `Маршрут "${routeQuery}" не найден.` };
      }

      const yesNo = (v: boolean | null) => v === null ? 'нет данных' : (v ? 'да' : 'нет');
      const list  = (arr: string[]) => arr.length > 0 ? arr.join(', ') : 'нет данных';

      const lines = [
        `<b>Pre-flight safety-чек: ${safety.title}</b>`,
        '',
        `Трек (geometry): ${safety.hasGeometry ? 'есть' : 'нет данных'}`,
        `Контакт МЧС: ${safety.hasMchsContact ? 'есть' : 'нет данных'}`,
        `Регистрация в МЧС обязательна: ${yesNo(safety.mchsRegistrationRequired)}`,
        `Сложность: ${safety.difficulty ?? 'нет данных'}`,
        `Опасности: ${list(safety.hazards)}`,
        `Снаряжение: ${list(safety.equipment)}`,
      ];

      return { response: lines.join('\n'), data: { ...safety } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка проверки маршрута';
      return { response: `Не удалось выполнить safety-чек: ${msg}` };
    }
  }
}
