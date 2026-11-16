/**
 * Permissions-Policy (аудит 16.11, #3463) — поведением next.config: какой
 * заголовок получает каждая страница, и не закрыто ли то, чем сайт пользуется.
 *
 * Черновик аудита `microphone=()` сломал бы голосовой ввод ИИ-помощника, а
 * запрет датчиков — компас на /planning (deviceorientation в Chrome закрыт
 * accelerometer/gyroscope/magnetometer). Поэтому сторож держит связку: функция
 * в коде — разрешение `self` в заголовке.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();
const req = createRequire(join(ROOT, 'package.json'));
const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (s: string, o: Record<string, unknown>) => (p: string) => false | object;
};
const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as { modifyRouteRegex: (r: string) => string };
const cfg = req(join(ROOT, 'next.config.js')) as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };

async function policyFor(path: string): Promise<Map<string, string> | null> {
  let value: string | null = null;
  for (const rule of await cfg.headers()) {
    const m = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
    if (m(path) === false) continue;
    for (const h of rule.headers) if (h.key.toLowerCase() === 'permissions-policy') value = h.value;
  }
  if (value === null) return null;
  return new Map(value.split(',').map((d) => d.trim()).map((d) => {
    const [k, v] = d.split('=');
    return [k, v] as [string, string];
  }));
}

const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

describe('Permissions-Policy', () => {
  it('стоит на страницах сайта и на виджете', async () => {
    for (const p of ['/', '/planning', '/ai-assistant', '/safety', '/catalog/tours/x', '/widget/abc', '/api/tours']) {
      expect(await policyFor(p), p).not.toBeNull();
    }
  });

  it('то, чем сайт пользуется, разрешено своему сайту — и только ему', async () => {
    const used: Array<[string, string, RegExp]> = [
      ['microphone', 'app/ai-assistant/_AIAssistantClient.tsx', /SpeechRecognition/],
      ['camera', 'components/safety/SosQrScanner.tsx', /getUserMedia/],
      ['accelerometer', 'app/planning/_PlanningClient.tsx', /DeviceOrientationEvent/],
      ['gyroscope', 'app/planning/_PlanningClient.tsx', /DeviceOrientationEvent/],
      ['magnetometer', 'app/planning/_PlanningClient.tsx', /DeviceOrientationEvent/],
    ];
    const policy = (await policyFor('/'))!;
    for (const [feature, file, marker] of used) {
      expect(read(file), `${feature}: ${file}`).toMatch(marker);
      expect(policy.get(feature), feature).toBe('(self)');
    }
    expect(policy.get('geolocation')).toBe('(self)');
  });

  it('железо, которым сайт не пользуется, закрыто всем; оплата не тронута', async () => {
    const policy = (await policyFor('/'))!;
    for (const f of ['usb', 'serial', 'bluetooth', 'hid', 'midi']) expect(policy.get(f), f).toBe('()');
    // Приём оплаты выключен; запрет payment ждал бы его возвращения тихой ловушкой.
    expect(policy.has('payment')).toBe(false);
    // Ни одна функция не открыта чужим источникам.
    expect([...policy.values()].every((v) => v === '()' || v === '(self)')).toBe(true);
  });
});
