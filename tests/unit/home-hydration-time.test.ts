/**
 * React #418 на главной (04.10): текст, зависящий от часов и часового пояса,
 * расходился между сервером (UTC) и телефоном на Камчатке — и страница
 * перерисовывалась целиком.
 *
 *  - дата новости в ленте — по Камчатке, явно: одинакова на сервере и в
 *    браузере при любом поясе процесса;
 *  - «N мин назад» неизбежно разное на сервере и в браузере — такие строки
 *    помечены suppressHydrationWarning.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function stampIn(tz: string, at: string): string {
  // Отдельный процесс: пояс читается при старте, в текущем его не сменить.
  return execFileSync(process.execPath, ['--import', 'tsx', '-e',
    `import('./components/safety/LiveStatus.tsx').then(m => process.stdout.write((m.alertStamp ?? m.default.alertStamp)({ type: 'earthquake', at: '${at}', until: null })))`,
  ], { env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: process.cwd() });
}

describe('дата новости — камчатская, одна на сервер и браузер', () => {
  it('событие 15:00 UTC (03:00 следующего дня на Камчатке) печатается одним днём в UTC и на Камчатке', () => {
    const at = '2026-10-03T15:00:00Z';
    const utc = stampIn('UTC', at).split(' · ')[0];
    const kam = stampIn('Asia/Kamchatka', at).split(' · ')[0];
    expect(utc).toBe(kam);
    expect(kam).toMatch(/^4 окт/);
  }, 30_000);
});

describe('строки «сколько прошло» помечены', () => {
  it('лента, сейсмика, вулканы, плитка радара и пилюля', () => {
    const live = read('components/safety/LiveStatus.tsx');
    expect(live).toContain('<span className="ago" suppressHydrationWarning>{alertStamp(a)}</span>');
    expect(live).toContain('<span suppressHydrationWarning>сильнейший');
    expect((live.match(/suppressHydrationWarning/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(live).toMatch(/timeZone: KAMCHATKA_TZ/);
    const home = read('app/_home/_HomeV8Client.tsx');
    expect(home).toContain('<span className="qt-st" suppressHydrationWarning>{freshnessShort(fresh)}</span>');
    expect(home).toMatch(/className=\{`pill pill-\$\{pill\.tone\}`\} href="#radar" suppressHydrationWarning/);
  });
});
