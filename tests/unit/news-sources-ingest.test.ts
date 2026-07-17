/**
 * tests/unit/news-sources-ingest.test.ts
 *
 * Новостные источники в живом конвейере алертов (после пропущенной
 * дорожной новости):
 * - ingestNewsFeeds: kamgov RSS-item с ограничением проезда попадает в
 *   external_alerts с source_id kamgov/... (раньше kamgov читался только
 *   Scout Digest мимо алертов); недоступный optional-источник
 *   (visitkamchatka) не считается ошибкой;
 * - ingestTelegramNewsHtml: пост minec_tourism с закрытием проезда
 *   классифицируется и сохраняется;
 * - /api/routes/[id] отдаёт operationalAlerts точек маршрута
 *   (alert_message/is_open/active_alerts через route_waypoints).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { ingestNewsFeeds, ingestTelegramNewsHtml } from '@/lib/services/seismic-parser';
import { GET as getRoute } from '@/app/api/routes/[id]/route';

const KAMGOV_RSS = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>Ограничение движения к Вилючинскому перевалу</title>
  <link>https://kamgov.ru/news/road-1</link>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <description>С 15 июля проезд от Термального к Вилючинскому перевалу будет осуществляться строго по пропускам. Окна проезда 07:00-08:00, 13:00-14:00, 19:00-20:00.</description>
</item>
<item>
  <title>Открылась выставка камчатских художников</title>
  <link>https://kamgov.ru/news/art-1</link>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <description>В краевой библиотеке открылась выставка живописи.</description>
</item>
</channel></rss>`;

// Разметка как у t.me/s/<channel>: пары message_text + ссылка с <time>
const MINEC_HTML = `
<div class="tgme_widget_message_text js-message_text" dir="auto">Внимание! С 8:00 20 июля до 18:00 27 июля будет закрыт проезд к горному массиву Вачкажец. Объезд через поля со стороны посёлка Сокоч.</div></div>
<a class="tgme_widget_message_date" href="https://t.me/minec_tourism/101"><time datetime="${new Date().toISOString()}"></time></a>`;

beforeEach(() => {
  queryMock.mockReset();
  fetchMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

describe('ingestNewsFeeds', () => {
  it('kamgov: дорожная новость попадает в external_alerts, нейтральная — нет', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('kamgov.ru')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(KAMGOV_RSS) });
      }
      // visitkamchatka недоступен
      return Promise.resolve({ ok: false, text: () => Promise.resolve('') });
    });

    const result = await ingestNewsFeeds();

    expect(result.events).toHaveLength(1);
    expect(result.events[0].alert_type).toBe('road_closure');
    expect(result.events[0].source_id).toMatch(/^kamgov\//);
    expect(result.inserted).toBe(1);
    // visitkamchatka — optional: недоступность не ошибка
    expect(result.errors).toHaveLength(0);
  });

  it('kamgov недоступен → честная ошибка конвейера', async () => {
    fetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('') });

    const result = await ingestNewsFeeds();
    expect(result.errors.some(e => e.includes('kamgov'))).toBe(true);
  });
});

describe('ingestTelegramNewsHtml', () => {
  it('пост minec_tourism о закрытии проезда сохраняется как road_closure', async () => {
    const result = await ingestTelegramNewsHtml(MINEC_HTML);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].alert_type).toBe('road_closure');
    expect(result.events[0].severity).toBe(2);

    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO external_alerts'));
    expect(insertCall).toBeDefined();
  });

  it('пустой HTML — ничего не сохраняется', async () => {
    const result = await ingestTelegramNewsHtml('');
    expect(result.events).toHaveLength(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/routes/[id] — operationalAlerts', () => {
  const ROUTE_ID = '11111111-1111-4111-8111-111111111111';

  it('отдаёт живые ограничения точек маршрута', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('location_real_time_status')) {
        return Promise.resolve({
          rows: [{
            place_name: 'Вачкажец', place_id: 'ark-1',
            is_open: true,
            alert_message: 'Проезд закрыт 20-27 июля, объезд через Сокоч',
            active_alerts: ['Вачкажец: проезд закрыт 20-27 июля'],
            alert_severity: 2,
          }],
        });
      }
      if (sql.includes('route_waypoints')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [] });
      // основной запрос маршрута
      return Promise.resolve({
        rows: [{
          id: 'route-1', route_dedupe_key: 'vachkazhets', category: 'trekking',
          title: 'Вачкажец', description: 'Горный массив', payload: {},
        }],
      });
    });

    const req = new Request(`http://localhost/api/routes/${ROUTE_ID}`) as unknown as NextRequest;
    const res = await getRoute(req, { params: Promise.resolve({ id: ROUTE_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { operationalAlerts: Array<{ placeName: string; message: string; severity: number }> } };
    expect(body.data.operationalAlerts).toHaveLength(1);
    expect(body.data.operationalAlerts[0].placeName).toBe('Вачкажец');
    expect(body.data.operationalAlerts[0].message).toContain('объезд через Сокоч');
    expect(body.data.operationalAlerts[0].severity).toBe(2);
  });

  it('дубли в active_alerts схлопываются, показ ограничен тремя + hiddenAlertsCount', async () => {
    const spam = 'Экстренное предупреждение на 16-20 июля 2026 г.';
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('location_real_time_status')) {
        return Promise.resolve({
          rows: [{
            place_name: 'Козельский', place_id: 'ark-2',
            is_open: true, alert_message: null,
            active_alerts: [spam, spam, spam, spam, spam, spam, 'Камнепад на тропе', 'Медведь у ручья', 'Туман на перевале', 'Ветер 25 м/с'],
            alert_severity: 1,
          }],
        });
      }
      if (sql.includes('route_waypoints')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [{
          id: 'route-1', route_dedupe_key: 'kozelsky', category: 'trekking',
          title: 'Козельский', description: 'Вулкан', payload: {},
        }],
      });
    });

    const req = new Request(`http://localhost/api/routes/${ROUTE_ID}`) as unknown as NextRequest;
    const res = await getRoute(req, { params: Promise.resolve({ id: ROUTE_ID }) });
    const body = await res.json() as { data: { operationalAlerts: Array<{ activeAlerts: string[]; hiddenAlertsCount: number }> } };

    const alert = body.data.operationalAlerts[0];
    // 10 сырых строк → 5 уникальных → 3 показанных + 2 скрытых
    expect(alert.activeAlerts).toHaveLength(3);
    expect(alert.activeAlerts.filter(t => t === spam)).toHaveLength(1);
    expect(alert.hiddenAlertsCount).toBe(2);
  });
});
