/**
 * Ссылка «Продолжить в Ведаре» из make_trip_plan открывает план на те же
 * даты (проверка MCP 29.09, T17).
 *
 * Ссылка несла только days и interests: планер ставил старт «через месяц», а
 * отъезд — «старт + days», то есть восемь календарных дней из «7 дней», хотя
 * движок с 27.09 считает дни включительно. План на июль 2027 открывался на
 * другие даты и другую длину.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { handoffTargetForTool } from '@/lib/mcp/handoff-targets';
import { isSafeTarget } from '@/lib/mcp/handoff';

describe('ссылка плана несёт дату старта', () => {
  it('when с датой — from той же даты, цель проходит белый список', async () => {
    const t = await handoffTargetForTool('make_trip_plan', { days: '7', interests: 'вулканы', when: '2027-07-10' });
    expect(t?.targetPath).toMatch(/[?&]from=2027-07-10(&|$)/);
    expect(t && isSafeTarget(t)).toBe(true);
  });

  it('без when — без from: планер сам ставит старт, как и движок', async () => {
    const t = await handoffTargetForTool('make_trip_plan', { days: '7' });
    expect(t?.targetPath).not.toMatch(/from=/);
  });
});

describe('планер: дни включительно, from — из ссылки', () => {
  const src = readFileSync('app/planner/_PlannerClient.tsx', 'utf-8');
  it('отъезд = старт + (days − 1), а не + days', () => {
    expect(src).toMatch(/\(linkDays - 1\) \* 86400000/);
    expect(src).not.toMatch(/isoInDays\(30 \+ linkDays\)/);
  });
  it('from читается и прошедшая дата не принимается', () => {
    expect(src).toMatch(/searchParams\.get\('from'\)/);
    expect(src).toMatch(/raw >= isoInDays\(0\)/);
  });
});
