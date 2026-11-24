import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSosSurface } from '@/lib/legal/sos-surface';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('на экранах SOS нет баннера согласия и сторонних скриптов', () => {
  it('isSosSurface — только /sos и его подмаршруты', () => {
    expect(isSosSurface('/sos')).toBe(true);
    expect(isSosSurface('/sos/relay')).toBe(true);
    expect(isSosSurface('/sos/relay/')).toBe(true);
    expect(isSosSurface('/emergency')).toBe(false);
    expect(isSosSurface('/safety')).toBe(false);
    expect(isSosSurface('/soso')).toBe(false);
    expect(isSosSurface('/')).toBe(false);
    expect(isSosSurface(null)).toBe(false);
  });

  it('ThirdPartyScripts выходит на SOS-маршруте до баннера и скриптов', () => {
    const src = read('components/legal/ThirdPartyScripts.tsx');
    expect(src).toMatch(/from '@\/lib\/legal\/sos-surface'/);
    const sos = src.indexOf('isSosSurface(pathname)');
    const banner = src.indexOf('role="dialog"');
    expect(sos).toBeGreaterThan(0);
    expect(banner).toBeGreaterThan(sos);
    expect(src).toMatch(/isSosSurface\(pathname\)\) return null/);
  });

  it('/sos/relay закрыт от индекса; /emergency каноничен на /sos и закрыт от индекса', () => {
    const relay = read('app/sos/relay/layout.tsx');
    expect(relay).toMatch(/index:\s*false/);
    expect(read('app/sos/layout.tsx')).toMatch(/canonical:\s*'\/sos'/);
    const emergency = read('public/emergency.html');
    expect(emergency).toContain('rel="canonical" href="https://vedarai.ru/sos"');
    expect(emergency).toContain('name="robots" content="noindex, follow"');
    expect(emergency).not.toContain('rel="canonical" href="https://vedarai.ru/emergency"');
    expect(read('app/emergency/route.ts')).toMatch(/X-Robots-Tag': 'noindex, follow'/);
  });

  it('/sos рядом с кнопкой отправки объясняет, куда уйдут данные, без чекбокса', () => {
    const src = read('app/sos/page.tsx');
    expect(src).toMatch(/уйдут дежурным Ведара в Telegram/);
    expect(src).toMatch(/\/legal\/privacy/);
    expect(src).not.toMatch(/type=["']checkbox["']/);
  });
});
