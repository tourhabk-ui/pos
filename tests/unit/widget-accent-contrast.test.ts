// @vitest-environment jsdom
/**
 * Кнопки виджетов партнёра без своего цвета держат AA для белого текста —
 * находка аудита 15.10 WID-config (W10).
 *
 * Светлый `--accent` затемнён 02.10 (#D44A0C → #C2410A): белый на прежнем
 * давал 4,39:1 при пороге 4,5 (CLAUDE.md §2). Виджеты на чужих сайтах CSS-
 * переменных платформы не видят и держали свой литерал — прежний, на всех
 * кнопках партнёров без своего цвета: lead.js, чат embed.js, окно формы и
 * чата через /api/widget/partner. Вдобавок DEFAULT колонки из 142 записывал
 * #D44A0C в конфиг каждого нового партнёра — он выглядел как выбор.
 *
 * Судится вызовом: что каждая поверхность на деле красит, и какой контраст
 * у белого на этом цвете. Умолчание виджета сверяется со светлым токеном
 * `--accent` в globals.css — следующее затемнение акцента без виджета
 * сделает этот файл красным.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { widgetStyle, WIDGET_DEFAULT_ACCENT } from '@/lib/embed/widget-style';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/database', () => ({ query: m.query }));

import { GET as leadJs } from '@/app/api/widget/lead.js/route';
import { GET as partnerApi } from '@/app/api/widget/partner/[partnerId]/route';

const ROOT = process.cwd();

function hex6(color: string): string {
  const c = color.trim();
  const rgb = c.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (rgb) return '#' + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  return c;
}
function lum(color: string): number {
  const hex = hex6(color);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function whiteOn(color: string): number {
  return (1 + 0.05) / (lum(color) + 0.05);
}

/** Заготовка колонки из 142 — лежит у партнёров, заведённых до 1280. */
const LEGACY_142 = { greeting: 'Привет!', accentColor: '#D44A0C', buttonText: 'Чат', position: 'right' };

beforeEach(() => {
  m.query.mockReset();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__th_widget_t;
});

describe('цвет кнопок виджета по умолчанию держит AA', () => {
  it('умолчание — светлый --accent из globals.css, и белый на нём не ниже 4,5:1', () => {
    const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf-8');
    const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'));
    const accent = lightBlock.match(/--accent:\s*(#[0-9A-Fa-f]{6})/)?.[1];
    expect(accent).toBeTruthy();
    expect(WIDGET_DEFAULT_ACCENT.toLowerCase()).toBe(accent!.toLowerCase());
    expect(whiteOn(WIDGET_DEFAULT_ACCENT)).toBeGreaterThanOrEqual(4.5);
    // Прежний акцент — ниже порога: ради него этот сторож и стоит.
    expect(whiteOn('#D44A0C')).toBeLessThan(4.5);
  });

  it('widgetStyle: пусто, мусор и заготовка 142 — умолчание; свой цвет партнёра — его', () => {
    for (const cfg of [{}, { accentColor: 'red' }, LEGACY_142, { accentColor: '#d44a0c' }]) {
      const { accent } = widgetStyle(cfg);
      expect(accent).toBe(WIDGET_DEFAULT_ACCENT);
      expect(whiteOn(accent)).toBeGreaterThanOrEqual(4.5);
    }
    expect(widgetStyle({ accentColor: '#003466' }).accent).toBe('#003466');
  });

  it('lead.js: кнопка партнёра с заготовкой 142 красится в AA-цвет', async () => {
    m.query.mockResolvedValue({ rows: [{ name: 'Т', slug: 't', widget_config: LEGACY_142, widget_domains: [] }] });
    const res = await leadJs(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=t'));
    new Function(await res.text())();
    const btn = document.getElementById('__th_btn_t') as HTMLButtonElement;
    expect(btn.style.color).toMatch(/#fff|rgb\(255, 255, 255\)/i);
    expect(whiteOn(btn.style.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('/api/widget/partner: окно формы и чата без своего цвета — AA-цвет', async () => {
    m.query.mockResolvedValue({ rows: [{
      name: 'Т', category: 'operator', short_description: null, logo_image: null,
      widget_config: LEGACY_142, widget_domains: [],
    }] });
    const res = await partnerApi(new NextRequest('https://vedarai.ru/api/widget/partner/t'),
      { params: Promise.resolve({ partnerId: 't' }) });
    const body = await res.json() as { data: { accentColor: string } };
    expect(body.data.accentColor).toBe(WIDGET_DEFAULT_ACCENT);
    expect(whiteOn(body.data.accentColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('embed.js: кнопка чата без data-color — AA-цвет', () => {
    const s = document.createElement('script');
    s.src = 'https://vedarai.ru/widget/embed.js';
    s.setAttribute('data-partner-id', 't');
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
    new Function(readFileSync(join(ROOT, 'public/widget/embed.js'), 'utf-8'))();
    const btn = document.getElementById('tourhub-widget-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // Цвет кнопки задаёт таблица стилей скрипта; jsdom её применяет.
    const painted = getComputedStyle(btn).backgroundColor;
    expect(painted).toMatch(/^rgb\(/);
    expect(whiteOn(painted)).toBeGreaterThanOrEqual(4.5);
  });
});
