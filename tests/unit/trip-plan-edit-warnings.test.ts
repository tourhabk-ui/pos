/**
 * Ответ правки плана не теряет критичное (#3199, M10).
 *
 * `edit_trip_plan` печатал только предупреждения самой правки: критичная
 * «дня на возвращение нет» пропадала. Хранить строки сборки и повторять их
 * нельзя — после правки они могут стать неправдой. Поэтому ответ правки
 * пересчитывает из дней то, что из них выводится (самопроверка возвращения,
 * теми же словами, что у движка), а чего не вывести — называет одной строкой.
 * Судится вызовом: чистые функции и сам инструмент с подменённой базой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DayPlan } from '@/lib/planner/engine';
import type { ZoneId } from '@/lib/planner/constants';

let poolReply: (sql: string) => { rows: unknown[] } = () => ({ rows: [] });
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async (sql: string) => poolReply(sql)) },
}));

import { editTripPlanForKuzmich } from '@/lib/kuzmich/trip-plan-tool';
import {
  EDIT_NOT_RECHECKED_NOTE, missingReturnZone, planWideAfterEdit, returnLegMissingMessage,
} from '@/lib/planner/plan-edit-warnings';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const day = (n: number, type: DayPlan['type'], zone: ZoneId, title: string): DayPlan => ({
  day: n, type, zone, title, description: '', activityType: type === 'activity' ? 'fishing' : 'rest',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
});
const PARAMS = {
  interests: ['fishing'], arrivalDate: '2027-07-10', departureDate: '2027-07-14',
  adults: 2, children: [], budgetTier: 'comfort',
};

beforeEach(() => { poolReply = () => ({ rows: [] }); });

describe('самопроверка возвращения — из дней плана', () => {
  it('последний день перед отъездом в Западной зоне — возвращения нет', () => {
    const days = [day(1, 'arrival', 'avachinsky', 'Прилёт'), day(2, 'travel', 'western', 'Переезд'),
      day(3, 'activity', 'western', 'Рыбалка'), day(4, 'departure', 'avachinsky', 'Отъезд')];
    expect(missingReturnZone(days)).toBe('western');
    expect(planWideAfterEdit(days)).toEqual([returnLegMissingMessage('western', undefined)]);
    expect(planWideAfterEdit(days)[0]).toMatch(/дня на возвращение в Петропавловск в нём нет/);
  });

  it('день возвращения есть, Северная зона (туда и обратно за день) и город — тревоги нет', () => {
    expect(missingReturnZone([day(1, 'activity', 'western', 'Рыбалка'), day(2, 'travel', 'avachinsky', 'Возвращение'),
      day(3, 'departure', 'avachinsky', 'Отъезд')])).toBeNull();
    expect(missingReturnZone([day(1, 'activity', 'northern', 'Гейзеры'), day(2, 'departure', 'avachinsky', 'Отъезд')])).toBeNull();
    expect(missingReturnZone([day(1, 'activity', 'avachinsky', 'Вулкан')])).toBeNull();
  });
});

describe('ответ edit_trip_plan', () => {
  const answer = (days: DayPlan[]) => {
    poolReply = (sql) => {
      if (sql.includes('FROM trip_plan_drafts')) return { rows: [{ id: ID, params: PARAMS, days, revision: 1 }] };
      if (sql.startsWith('UPDATE')) return { rows: [{ revision: 2 }] };
      return { rows: [] };
    };
    return editTripPlanForKuzmich({ plan_id: ID, action: 'set_lodging', lodging: 'на базу' });
  };

  it('план без дня возвращения — критичная строка в ответе правки', async () => {
    const text = await answer([day(1, 'arrival', 'avachinsky', 'Прилёт'), day(2, 'travel', 'western', 'Переезд'),
      day(3, 'activity', 'western', 'Рыбалка'), day(4, 'activity', 'western', 'Рыбалка'), day(5, 'departure', 'avachinsky', 'Отъезд')]);
    expect(text).toContain(returnLegMissingMessage('western', undefined));
  });

  it('чего правка не пересчитывает — названо, а не пропадает молча', async () => {
    const text = await answer([day(1, 'arrival', 'avachinsky', 'Прилёт'), day(2, 'activity', 'avachinsky', 'Вулкан'),
      day(3, 'departure', 'avachinsky', 'Отъезд')]);
    expect(text).toContain(EDIT_NOT_RECHECKED_NOTE);
    expect(text).not.toMatch(/дня на возвращение/);
  });
});
