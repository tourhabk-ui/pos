/**
 * Виджет Ведара на сайте «Местечка Камчатка» (владелец 15.10: «вставь в сайт
 * местечка наш виджет»).
 *
 * Сайт партнёра ведёт сторонний разработчик — строку вставляет он; с нашей
 * стороны виджет обязан работать с mestechkokam.ru в тот же момент. Держится
 * две вещи: миграция 1260 по смыслу (гейт по slug, домен в белом списке,
 * включение, идемпотентность) и поведение выдачи скрипта с их домена — вызов
 * роута /api/widget/lead.js с Origin партнёра.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const MIG = readFileSync(join(process.cwd(), 'migrations/1260_mestechko_widget_domain.sql'), 'utf-8');

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));

import { GET as leadJs } from '@/app/api/widget/lead.js/route';

const PARTNER = { name: 'Местечко Камчатка', slug: 'mestechko', widget_config: null, widget_domains: ['mestechkokam.ru'] };

function req(origin?: string) {
  return new NextRequest('http://localhost/api/widget/lead.js?partner=mestechko', {
    headers: origin ? { Origin: origin } : {},
  });
}

describe('миграция 1260 — по смыслу', () => {
  it('включает виджет и вносит домен сайта партнёра, гейт по slug mestechko', () => {
    expect(MIG).toMatch(/widget_enabled = true/);
    expect(MIG).toMatch(/array_append\(COALESCE\(widget_domains, '\{\}'\), 'mestechkokam\.ru'\)/);
    // Каждый UPDATE адресован только этому партнёру.
    const updates = MIG.split(/\bUPDATE partners\b/).slice(1);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) expect(u).toMatch(/WHERE slug = 'mestechko'/);
  });

  it('идемпотентна: домен не дописывается второй раз, чужое приветствие не перетирается', () => {
    expect(MIG).toMatch(/NOT \('mestechkokam\.ru' = ANY \(COALESCE\(widget_domains, '\{\}'\)\)\)/);
    expect(MIG).toMatch(/widget_config->>'greeting' = 'Привет!'/);
    expect(MIG).not.toMatch(/accentColor/);
  });
});

describe('скрипт формы заявки с сайта партнёра', () => {
  beforeEach(() => { m.query.mockReset(); });

  it('с mestechkokam.ru (и www) отдаётся скрипт с формой партнёра и разрешением CORS', async () => {
    m.query.mockResolvedValue({ rows: [PARTNER] });
    for (const origin of ['https://mestechkokam.ru', 'https://www.mestechkokam.ru']) {
      const res = await leadJs(req(origin));
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      const js = await res.text();
      expect(js).toContain("var SLUG = 'mestechko'");
      expect(js).toContain('/widget/lead-form/');
    }
  });

  it('с чужого домена разрешения CORS нет', async () => {
    m.query.mockResolvedValue({ rows: [PARTNER] });
    const res = await leadJs(req('https://evil.example'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('виджет выключен — скрипт не выдаётся', async () => {
    m.query.mockResolvedValue({ rows: [] });
    const res = await leadJs(req('https://mestechkokam.ru'));
    expect(res.status).toBe(404);
  });
});
