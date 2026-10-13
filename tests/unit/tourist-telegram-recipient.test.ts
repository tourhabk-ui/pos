/**
 * Куда писать туристу в Telegram (разбор 13.10, «как туристы оставляют
 * отзывы?»).
 *
 * Просьба об отзыве после тура и напоминание накануне искали адрес в
 * users.telegram_chat_id — колонке, которую не пишет никто (привязка пишет
 * users.telegram_id). Отбор не находил ни одного туриста с сайта, а крон
 * отвечал «отправлено 0» — как будто слать было некому.
 *
 * Сторож держит:
 *   · правило адреса одно — TOURIST_TG_CHAT_SQL, и в нём есть telegram_id;
 *   · просьба об отзыве уходит по нему, а брони, которым писать некуда,
 *     называются числом (no_channel), а не пропадают в «0»;
 *   · просьба — только за туры, закончившиеся не раньше 14 дней назад: без
 *     окна первый рабочий прогон спросил бы про поездки месячной давности;
 *   · напоминание отбирает и адресует по тому же правилу;
 *   · запрет: users.telegram_chat_id сам по себе в рассылках по броням —
 *     только через правило.
 * SQL отбора проверен на PostgreSQL 16 (13.10): из трёх завершённых броней
 * — с telegram_id, без Telegram, без аккаунта — выбрана первая, no_channel 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: vi.fn(async () => 'Завтра тур. Возьмите дождевик.') }));
vi.mock('@/lib/max/max-fetch', () => ({ maxBot: vi.fn() }));

import { TOURIST_TG_CHAT_SQL } from '@/lib/notifications/tourist-telegram';
import { REVIEW_REQUEST_MAX_AGE_DAYS } from '@/lib/notifications/guest-experience-copy';
import { TOUR_LAST_DAY_SQL } from '@/lib/bookings/tour-last-day';

const SECRET = 'test-cron-secret';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const req = (path: string) => new NextRequest(`https://vedarai.ru${path}`, {
  headers: { authorization: `Bearer ${SECRET}` },
});
const flat = (s: unknown) => String(s).replace(/\s+/g, ' ');

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  poolQuery.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('правило адреса', () => {
  it('telegram_chat_id, а без него — telegram_id: его пишет привязка', () => {
    expect(TOURIST_TG_CHAT_SQL).toBe('COALESCE(u.telegram_chat_id, u.telegram_id)');
  });
});

describe('просьба об отзыве', () => {
  it('отбирает и адресует по правилу; писать некуда — числом no_channel', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 2 }] };
      if (/^\s*SELECT/.test(sql)) {
        return { rows: [{ id: 11, tourist_name: 'Анна', tour_id: 62, tour_title: 'Авачинский перевал', telegram_chat_id: '555' }] };
      }
      return { rows: [] };
    });
    const { GET } = await import('@/app/api/cron/tour-review-request/route');
    const res = await GET(req('/api/cron/tour-review-request'));
    const body = await res.json();

    const selectCall = poolQuery.mock.calls.find((c) => /review_requested_at IS NULL/.test(String(c[0])) && /LIMIT 200/.test(String(c[0])));
    const select = flat(selectCall?.[0]);
    expect(select).toContain(`(${TOURIST_TG_CHAT_SQL})::text AS telegram_chat_id`);
    expect(select).toContain(`${TOURIST_TG_CHAT_SQL} IS NOT NULL`);
    // Окно: только туры, закончившиеся не раньше REVIEW_REQUEST_MAX_AGE_DAYS назад.
    const recent = `${TOUR_LAST_DAY_SQL} >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date - $1::int`;
    expect(select).toContain(recent);
    expect(selectCall?.[1]).toEqual([REVIEW_REQUEST_MAX_AGE_DAYS]);

    const noChannelCall = poolQuery.mock.calls.find((c) => /COUNT\(\*\)::int AS n/.test(String(c[0])));
    const noChannel = flat(noChannelCall?.[0]);
    expect(noChannel).toContain("ob.booking_status = 'completed'");
    expect(noChannel).toContain(`(u.id IS NULL OR ${TOURIST_TG_CHAT_SQL} IS NULL)`);
    expect(noChannel).toContain(recent);
    expect(noChannelCall?.[1]).toEqual([REVIEW_REQUEST_MAX_AGE_DAYS]);

    // Отправлено в чат, найденный правилом, и отмечено.
    const sent = fetchMock.mock.calls.find((c) => /sendMessage/.test(String(c[0])));
    expect(JSON.parse(String((sent?.[1] as { body: string }).body)).chat_id).toBe('555');
    expect(poolQuery.mock.calls.some((c) => /SET review_requested_at = NOW\(\)/.test(String(c[0])) && (c[1] as unknown[])[0] === 11)).toBe(true);
    expect(body).toMatchObject({ success: true, sent: 1, failed: 0, no_channel: 2 });
  });

  it('слать некому, но завершённые без Telegram есть — ответ это называет', async () => {
    poolQuery.mockImplementation(async (sql: string) => (
      /COUNT\(\*\)::int AS n/.test(sql) ? { rows: [{ n: 3 }] } : { rows: [] }
    ));
    const { GET } = await import('@/app/api/cron/tour-review-request/route');
    const body = await (await GET(req('/api/cron/tour-review-request'))).json();
    expect(body).toMatchObject({ success: true, sent: 0, no_channel: 3 });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/sendMessage/), expect.anything());
  });
});

describe('напоминание накануне', () => {
  it('аккаунт без бота — адрес по правилу', async () => {
    poolQuery.mockImplementation(async (sql: string) => (
      /reminder_sent_24h = false/.test(sql)
        ? { rows: [{ id: 21, tourist_name: 'Анна', booking_date: '2026-10-14', participants: 2, tour_title: 'Авачинский перевал', activity_type: 'jeep', location_name: null, difficulty: null, tg_chat_id: 555, platform: 'telegram' }] }
        : { rows: [] }
    ));
    fetchMock.mockImplementation(async (url: string) => (
      /sendMessage/.test(url) ? { ok: true, json: async () => ({}) } : { ok: false, text: async () => '', json: async () => ({}) }
    ));
    const { GET } = await import('@/app/api/cron/tour-reminder/route');
    const body = await (await GET(req('/api/cron/tour-reminder'))).json();

    const select = flat(poolQuery.mock.calls.find((c) => /reminder_sent_24h = false/.test(String(c[0])))?.[0]);
    expect(select).toContain(`COALESCE((ob.metadata->>'tg_chat_id')::bigint, ${TOURIST_TG_CHAT_SQL}) AS tg_chat_id`);
    expect(select).toContain(`OR ${TOURIST_TG_CHAT_SQL} IS NOT NULL`);
    const sent = fetchMock.mock.calls.find((c) => /sendMessage/.test(String(c[0])));
    expect(JSON.parse(String((sent?.[1] as { body: string }).body)).chat_id).toBe(555);
    expect(body).toMatchObject({ success: true, sent: 1 });
  });
});

describe('запрет', () => {
  it('рассылки по броням не читают users.telegram_chat_id мимо правила', () => {
    for (const file of ['app/api/cron/tour-review-request/route.ts', 'app/api/cron/tour-reminder/route.ts']) {
      const code = readFileSync(join(process.cwd(), file), 'utf-8')
        .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
      expect(code, file).not.toMatch(/\bu\.telegram_chat_id\b/);
    }
  });
});
