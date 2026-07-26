/**
 * Счётчик посещаемости: суточный хэш без сырых IP + таблица наконец
 * существует в миграциях (page_views писалась в никуда с рождения —
 * INSERT глотал "relation does not exist" через catch(() => {})).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';

describe('visitorHash', () => {
  const ip = '203.0.113.7';
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)';

  it('детерминирован в рамках дня — уникальных за день посчитать можно', () => {
    expect(visitorHash(ip, ua, '2026-07-26', 's')).toBe(visitorHash(ip, ua, '2026-07-26', 's'));
  });

  it('меняется на следующий день — длинный профиль не строится', () => {
    expect(visitorHash(ip, ua, '2026-07-26', 's')).not.toBe(visitorHash(ip, ua, '2026-07-27', 's'));
  });

  it('зависит от соли — без секрета перебором IP не восстановить', () => {
    expect(visitorHash(ip, ua, '2026-07-26', 'salt-a')).not.toBe(visitorHash(ip, ua, '2026-07-26', 'salt-b'));
  });

  it('сырого IP в хэше нет', () => {
    const h = visitorHash(ip, ua, '2026-07-26', 's');
    expect(h).not.toContain('203');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('currentDay — YYYY-MM-DD UTC', () => {
    expect(currentDay(new Date('2026-07-26T23:59:00Z'))).toBe('2026-07-26');
  });
});

describe('структурно: сток счётчика существует', () => {
  it('миграция 778 создаёт page_views идемпотентно (таблица + visitor_hash + индексы)', () => {
    const sql = readFileSync('migrations/778_page_views.sql', 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS page_views/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS visitor_hash/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_page_views_created_at/);
  });

  it('hit-эндпоинт пишет visitor_hash, сырые ip/ua в БД не уходят', () => {
    const src = readFileSync('app/api/analytics/hit/route.ts', 'utf8');
    expect(src).toMatch(/visitor_hash/);
    expect(src).toMatch(/visitorHash\(/);
    // В INSERT не должно быть сырого ip или user-agent
    const insert = src.slice(src.indexOf('INSERT INTO page_views'));
    expect(insert).not.toMatch(/\[.*\bip\b.*user-agent/i);
  });

  it('страница «Посещаемость» подключена в админ-меню', () => {
    const layout = readFileSync('app/hub/admin/layout.tsx', 'utf8');
    expect(layout).toContain("'/hub/admin/traffic'");
  });
});

describe('честность уникальных: подпись «считаются с даты»', () => {
  it('API даёт uniques_since только при наличии строк без хэша (не хардкод даты)', () => {
    const api = readFileSync('app/api/admin/analytics/traffic/route.ts', 'utf8');
    expect(api).toMatch(/MIN\(created_at\) FILTER \(WHERE visitor_hash IS NOT NULL\)/);
    expect(api).toMatch(/has_unhashed/);
    expect(api).toMatch(/uniques_since:\s*cov\?\.has_unhashed/);
  });

  it('страница показывает подпись, когда uniques_since есть', () => {
    const page = readFileSync('app/hub/admin/traffic/page.tsx', 'utf8');
    expect(page).toMatch(/Уникальные считаются с/);
    expect(page).toMatch(/data\?\.uniques_since/);
  });
});
