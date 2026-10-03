import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { watchView, positionSourceLabel, type WatchRow } from '@/lib/safety/watch-status';
import { buildEscalationMessage } from '@/lib/safety/checkin-escalation';

// 03.10: страница экстренного контакта (/watch). Правила — WATCH_MANIFEST, 6 и 9.
const NOW = new Date('2026-10-03T08:00:00Z');
const base: WatchRow = {
  route_name: 'Вулкан Горелый', trip_kind: 'day',
  expected_return_at: '2026-10-03T07:00:00Z', completed_at: null, closed_reason: null,
  checkin_confirmed_at: null, mchs_informed_at: null,
  last_position_lat: '52.558', last_position_lng: '158.030',
  last_position_at: '2026-10-03T05:10:00Z', last_position_source: 'tracker',
};

describe('что видит контакт', () => {
  it('срок прошёл — overdue, точка с временем и источником', () => {
    const v = watchView(base, NOW);
    expect(v.state).toBe('overdue');
    expect(v.position).toEqual({ lat: 52.558, lng: 158.03, at: '2026-10-03T05:10:00.000Z', source: 'tracker' });
  });

  it('срок не наступил — on_route; срока нет — no_deadline', () => {
    expect(watchView({ ...base, expected_return_at: '2026-10-03T10:00:00Z' }, NOW).state).toBe('on_route');
    expect(watchView({ ...base, expected_return_at: null }, NOW).state).toBe('no_deadline');
  });

  it('закрытый контроль точку не отдаёт (правило 9)', () => {
    const v = watchView({ ...base, completed_at: '2026-10-03T07:30:00Z', closed_reason: 'returned' }, NOW);
    expect(v.state).toBe('returned');
    expect(v.position).toBeNull();
    expect(watchView({ ...base, completed_at: NOW, closed_reason: 'cancelled' }, NOW).state).toBe('cancelled');
  });

  it('нет точки — null, а не ноль; источник не угадывается', () => {
    expect(watchView({ ...base, last_position_lat: null }, NOW).position).toBeNull();
    expect(positionSourceLabel(null)).toBe('источник не записан');
    expect(positionSourceLabel('что-то')).toBe('источник не записан');
    expect(positionSourceLabel('phone')).toBe('телефон');
  });
});

describe('вход и связка', () => {
  it('API пускает тем же правилом, что отметки, и только читает', () => {
    const api = readFileSync('app/api/safety/watch-status/route.ts', 'utf8');
    expect(api).toMatch(/openRegistrationForMark\(request, registration_id, leader_phone\)/);
    expect(api).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(readFileSync('lib/auth/public-api-routes.ts', 'utf8')).toMatch(/'\/api\/safety\/watch-status': \['POST'\]/);
  });

  it('ссылка на страницу уходит в тревоге сторожа', () => {
    expect(readFileSync('app/api/cron/checkin-watchdog/route.ts', 'utf8')).toMatch(/statusUrl: `\$\{SITE_BASE\}\/watch\?id=\$\{reg\.id\}`/);
    const msg = buildEscalationMessage({
      routeName: 'Р', leaderName: 'Л', leaderPhone: '+7', emergencyContactName: 'К', emergencyContactPhone: '+7',
      positionText: 'неизвестно', returnUrl: 'https://vedarai.ru/return?id=x', statusUrl: 'https://vedarai.ru/watch?id=x',
    }, 'hard', 2);
    expect(msg).toContain('https://vedarai.ru/watch?id=x');
  });

  it('манифест называет страницу', () => {
    expect(readFileSync('docs/safety/WATCH_MANIFEST.md', 'utf8')).toMatch(/Страница контакта \| `\/watch\?id=`/);
  });
});
