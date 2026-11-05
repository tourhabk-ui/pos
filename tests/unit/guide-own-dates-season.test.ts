// @vitest-environment node
/**
 * Гид открывает даты вне сезона тура — ответ называет сезон и где его
 * поменять (05.11). Андрей открыл Горелый 15.07–15.10, потом 1–14.07 и
 * увидел «вне сезона тура: 14» — прочитал как «не открывает».
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'u-1', role: 'guide' })) }));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: vi.fn(async () => 'guide-partner') }));
vi.mock('@/lib/guides/own-dates', () => ({
  openGuideTourDates: vi.fn(async ({ dates }: { dates: string[] }) => ({
    ok: true,
    perDate: dates.map((date) => ({ date, result: 'refused_season', seasonStart: '2027-07-15', seasonEnd: '2027-10-15', from: '2027-07-15', to: '2027-10-15' })),
  })),
}));

import { POST } from '@/app/api/guide/own/dates/route';

describe('/api/guide/own/dates: отказ по сезону словами', () => {
  it('1–14.07 при сезоне 15.07–15.10 — сезон назван, сказано, где его поменять', async () => {
    const res = await POST(new NextRequest('https://vedarai.ru/api/guide/own/dates', {
      method: 'POST',
      body: JSON.stringify({ tourId: '70', startDate: '2027-07-01', endDate: '2027-07-14', slots: 4 }),
    }));
    const json = await res.json() as { success: boolean; message: string };
    expect(json.success).toBe(true);
    expect(json.message).toMatch(/Открыто дат: 0/);
    expect(json.message).toMatch(/не открыто 14 вне сезона тура \(15\.07\.2027 — 15\.10\.2027\): расширьте сезон кнопкой «Править» у тура/);
  });
});
