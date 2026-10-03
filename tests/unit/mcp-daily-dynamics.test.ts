/**
 * Динамика MCP по дням (владелец 03.10: «добавь за день, хочу посмотреть
 * динамику»). Запрос проверен выполнением на базе со всеми миграциями
 * (30 строк, тихие дни нулями, свои отдельно); здесь держится форма, которую
 * легко сломать правкой: сутки камчатские, ряд без пропусков, свои и
 * проверки не смешаны с внешними, страница показывает «сегодня» и «вчера».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const route = readFileSync('app/api/admin/analytics/mcp/route.ts', 'utf8');
const page = readFileSync('app/hub/admin/mcp/page.tsx', 'utf8');

describe('динамика MCP по дням', () => {
  it('сутки камчатские, а не UTC/МСК', () => {
    expect(route).toMatch(/created_at AT TIME ZONE 'Asia\/Kamchatka'\)::date/);
    expect(route).toMatch(/NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date - 29/);
  });

  it('ряд без пропусков: тихий день — ноль, а не отсутствующая строка', () => {
    expect(route).toMatch(/generate_series\(/);
    expect(route).toMatch(/FROM days d\s+LEFT JOIN calls c/);
  });

  it('внешние считаются без своих и без проверок; свои и проверки — отдельными колонками', () => {
    expect(route).toMatch(/FILTER \(WHERE NOT c\.is_self AND NOT c\.is_probe\)\s+AS calls/);
    expect(route).toMatch(/FILTER \(WHERE c\.is_self\)\s+AS self/);
    expect(route).toMatch(/AS probe/);
    expect(route).toContain('daily_30d');
  });

  it('страница показывает сегодня и вчера и предупреждает о неполных сутках', () => {
    expect(page).toContain('Внешних сегодня');
    expect(page).toContain('Внешних вчера');
    expect(page).toMatch(/сутки ещё не закончились/);
    expect(page).not.toContain('daily_14d');
  });
});
