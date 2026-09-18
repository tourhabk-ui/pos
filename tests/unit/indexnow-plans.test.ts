/**
 * Сторож: пинг IndexNow по страницам планов — из того же источника, что
 * роут и sitemap, под секретом, и только после своей сборки.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 18.09 хаб /plans переписан под запрос «Камчатка туры план». Плановый
 * переобход при changefreq weekly — дни; IndexNow (Яндекс — соавтор) — минуты.
 * Bulk-подача требует admin-JWT и шлёт весь sitemap; здесь узкий роут под
 * CRON_SECRET, который раннер зовёт после деплоя.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Адреса — из PLAN_PRESETS (хаб + каждый пресет), не второй список; секрет
 * проверяется до пинга; workflow ждёт свою сборку, идёт только из main и
 * краснеет на не-200 телом ответа.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PLAN_PRESETS } from '@/lib/plans/presets';

vi.mock('@/lib/seo/indexnow', () => ({
  pingIndexNow: vi.fn(async (urls: string[]) => ({ ok: true, submitted: urls.length, status: 200 })),
}));

import { GET, planUrls } from '@/app/api/cron/indexnow-plans/route';
import { pingIndexNow } from '@/lib/seo/indexnow';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const WF = read('.github/workflows/indexnow-plans.yml');
const CODE = WF.replace(/^[ \t]*#.*$/gm, '');

describe('адреса планов — из PLAN_PRESETS', () => {
  it('хаб плюс каждый пресет, без дублей, без завершающего слэша базы', () => {
    const urls = planUrls('https://vedarai.ru/');
    expect(urls[0]).toBe('https://vedarai.ru/plans');
    expect(urls.length).toBe(PLAN_PRESETS.length + 1);
    expect(new Set(urls).size).toBe(urls.length);
    for (const p of PLAN_PRESETS) expect(urls).toContain(`https://vedarai.ru/plans/${p.slug}`);
  });
});

describe('роут', () => {
  it('без секрета — 401, пинга нет', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(new NextRequest('http://localhost/api/cron/indexnow-plans'));
    expect(res.status).toBe(401);
    expect(pingIndexNow).not.toHaveBeenCalled();
  });

  it('с секретом — пингует ровно адреса планов и отдаёт три поля исхода', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(new NextRequest('http://localhost/api/cron/indexnow-plans', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.submitted).toBe(PLAN_PRESETS.length + 1);
    expect(body.urls.length).toBe(PLAN_PRESETS.length + 1);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('error');
    expect(vi.mocked(pingIndexNow).mock.calls[0][0].length).toBe(PLAN_PRESETS.length + 1);
  });
});

describe('workflow', () => {
  it('маркер, только main, ждёт свою сборку, секрет проверяется до запроса, красный на не-200', () => {
    expect(CODE).toMatch(/\.github\/triggers\/indexnow-plans\.json/);
    expect(CODE).toMatch(/branches: \[main\]/);
    expect(CODE).not.toMatch(/claude\/\*\*/);
    expect(CODE).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
    const secretCheck = CODE.indexOf('secrets.CRON_SECRET }}" ]; then');
    const ping = CODE.indexOf('api/cron/indexnow-plans');
    expect(secretCheck).toBeGreaterThan(0);
    expect(ping).toBeGreaterThan(secretCheck);
    expect(CODE).toMatch(/if \[ "\$HTTP" != "200" \]; then[\s\S]*?exit 1/);
    expect(JSON.parse(read('.github/triggers/indexnow-plans.json'))).toHaveProperty('run');
  });
});
