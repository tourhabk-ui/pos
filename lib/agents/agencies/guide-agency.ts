/**
 * GuideAgency — агент для гидов.
 *
 * guide_schedule  — предстоящие назначения гида
 * guide_groups    — активные группы и количество туристов
 * guide_earnings  — сводка по заработку
 * guide_status    — combined: расписание + группы + заработок
 */

import { pool } from '@/lib/db-pool';
import type { AgentContext } from '../context-hub';

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
  booking_status: string;
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
      case 'guide_schedule':  return this.getSchedule(context);
      case 'guide_groups':    return this.getGroups(context);
      case 'guide_earnings':  return this.getEarnings(context);
      case 'guide_status':    return this.getStatus(context);
      default:
        return {
          response:
            'Доступные команды гида:\n' +
            '- расписание / мои туры\n' +
            '- мои группы\n' +
            '- мой заработок\n' +
            '- статус (всё сразу)',
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
           ob.id              AS booking_id,
           t.title            AS tour_title,
           ob.booking_date::text AS start_date,
           NULL::text            AS end_date,
           ob.participants    AS booked_slots,
           ob.booking_status
         FROM operator_bookings ob
         JOIN operator_tours t ON t.id = ob.operator_tour_id
         WHERE t.operator_id = $1
           AND ob.booking_status = 'confirmed'
           AND ob.booking_date >= CURRENT_DATE
           AND ob.deleted_at IS NULL
         ORDER BY ob.booking_date
         LIMIT 10`,
        [context.user.userId]
      );

      if (rows.length === 0) {
        return { response: 'Предстоящих назначений не найдено.' };
      }

      const lines = ['<b>Ваше расписание:</b>', ''];
      for (const r of rows) {
        const dates = r.end_date ? `${r.start_date} — ${r.end_date}` : r.start_date;
        lines.push(`${r.tour_title} | ${dates} | ${r.booked_slots} чел | ${r.booking_status}`);
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
           COUNT(DISTINCT ob.id)::text                AS active_groups,
           COALESCE(SUM(ob.participants), 0)::text    AS total_tourists
         FROM operator_bookings ob
         JOIN operator_tours t ON t.id = ob.operator_tour_id
         WHERE t.operator_id = $1
           AND ob.booking_status = 'confirmed'
           AND ob.booking_date >= CURRENT_DATE
           AND ob.deleted_at IS NULL`,
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
           COUNT(DISTINCT ob.id)::text              AS completed_tours,
           COALESCE(SUM(ob.final_price), 0)::text   AS estimated_earnings
         FROM operator_bookings ob
         JOIN operator_tours t ON t.id = ob.operator_tour_id
         WHERE t.operator_id = $1
           AND ob.booking_status = 'confirmed'
           AND ob.deleted_at IS NULL`,
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
}
