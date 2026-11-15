/**
 * Анкета группы: сколько детей едет с участником и возраст каждого (слово
 * владельца 15.11 «да, спрашивай число детей у каждого», миграция 1443).
 *
 * Судится то, что видит и отправляет человек (рендер), и ответ настоящего
 * обработчика POST /api/trip-groups/[id]/members (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';

const { addMember } = vi.hoisted(() => ({ addMember: vi.fn() }));
vi.mock('@/lib/planner/trip-groups', () => ({ addMember: (...a: unknown[]) => addMember(...a), MAX_GROUP_MEMBERS: 15 }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { POST } from '@/app/api/trip-groups/[id]/members/route';
import { TripGroupClient } from '@/app/trip-group/[id]/_TripGroupClient';

const GID = '11111111-2222-3333-4444-555555555555';
const BASE = { interests: ['bears'], fitness: 'moderate', budget: 'comfort', pd_consent: true };
let ip = 0;
async function post(body: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest(`http://localhost/api/trip-groups/${GID}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.66.${Math.floor(ip / 250)}.${ip % 250}`, 'x-forwarded-for': `10.66.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: GID }) });
  return { status: res.status, json: await res.json() as { success: boolean; error?: string } };
}

beforeEach(() => { addMember.mockReset().mockResolvedValue('added'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('POST /api/trip-groups/[id]/members', () => {
  it('возраст каждого ребёнка — массивом, младший — из него', async () => {
    expect((await post({ ...BASE, children_ages: [9, 6] })).status).toBe(200);
    expect(addMember.mock.calls[0][1]).toMatchObject({ childrenAges: [9, 6], youngestChild: 6 });
  });

  it('детей нет — пустой массив и null', async () => {
    await post({ ...BASE, children_ages: [] });
    expect(addMember.mock.calls[0][1]).toMatchObject({ childrenAges: [], youngestChild: null });
  });

  it('старый клиент шлёт только младшего — один ребёнок этого возраста', async () => {
    await post({ ...BASE, youngest_child: 7 });
    expect(addMember.mock.calls[0][1]).toMatchObject({ childrenAges: [7], youngestChild: 7 });
  });

  it('возраст вне 0–17 — отказ с причиной, в базу не пишется', async () => {
    const r = await post({ ...BASE, children_ages: [6, 19] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Возраст ребёнка — до 17');
    expect(addMember).not.toHaveBeenCalled();
  });
});

describe('анкета участника', () => {
  const SUMMARY = {
    id: GID, arrivalDate: '2027-07-10', departureDate: '2027-07-16', expiresAt: '2027-07-01T00:00:00Z',
    members: 1, maxMembers: 15,
    profile: {
      members: 3, interests: ['bears'], votes: [{ interest: 'bears', votes: 3 }], fitness: 'moderate' as const,
      budget: 'comfort' as const, seasickness: false, limitedMobility: false, children: [6, 9, 12], conflicts: [],
    },
  };

  it('сводка называет число детей группы и младшего', () => {
    render(<TripGroupClient summary={SUMMARY} />);
    expect(document.body.textContent).toContain('детей 3 (младшему 6)');
  });

  it('«Сколько детей» — столько полей возраста; отправляется возраст каждого', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    render(<TripGroupClient summary={{ ...SUMMARY, profile: null }} />);
    expect(screen.queryByTestId('group-kid-ages')).toBeNull();
    fireEvent.change(screen.getByLabelText('Сколько детей едет с вами'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Возраст ребёнка 1'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Возраст ребёнка 2'), { target: { value: '6' } });
    fireEvent.click(screen.getByLabelText(/Медведи/i));
    fireEvent.click(document.getElementById('trip-group-consent') as HTMLElement);
    fireEvent.submit(screen.getByRole('button', { name: 'Добавить мои пожелания' }).closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.children_ages).toEqual([9, 6]);
    expect(body).not.toHaveProperty('youngest_child');
  });

  it('возраст не указан — не отправляется, причина сказана', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<TripGroupClient summary={{ ...SUMMARY, profile: null }} />);
    fireEvent.change(screen.getByLabelText('Сколько детей едет с вами'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText(/Медведи/i));
    fireEvent.submit(screen.getByRole('button', { name: 'Добавить мои пожелания' }).closest('form')!);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Укажите возраст каждого ребёнка — от 0 до 17.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
