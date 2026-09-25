/**
 * Справка кабинета оператора не обещает того, чего нет.
 *
 * «Комиссия снижается автоматически с ростом оборота» — неправда с 11.09:
 * ставку назначает владелец, автомат её не меняет (§7, commission-rate-decided).
 * «Фильтры: 7 / 30 / 90 / 365 дней» — в селекторе аналитики только 7/30/90.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const HELP = read('app/hub/operator/help/_OperatorHelpClient.tsx');
const ANALYTICS = read('app/hub/operator/analytics/_AnalyticsClient.tsx');

describe('справка оператора', () => {
  it('не обещает автоматического снижения комиссии', () => {
    expect(HELP).not.toMatch(/Комиссия снижается автоматически/i);
    expect(HELP).not.toMatch(/комисси[а-я]* [а-я ]*снижа/i);
  });

  it('периоды аналитики в справке совпадают с опциями селектора', () => {
    const options = [...ANALYTICS.matchAll(/<option value="(\d+)">/g)].map((m) => m[1]);
    expect(options.length).toBeGreaterThan(0);
    const line = HELP.match(/'Фильтры: ([\d /]+) дней'/);
    expect(line).not.toBeNull();
    const promised = (line?.[1] ?? '').split('/').map((s) => s.trim());
    expect(promised).toEqual(options);
  });
});
