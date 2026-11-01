/**
 * D6 (02.11): тексты доверия в контуре заявок. Ни «мгновенно» без отрицания,
 * ни «временно недоступно/ограничено» как объяснение — заявку подтверждает
 * человек, это штатный путь. Разрешено: строка-запрет агенту («не пиши …»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app/api/mcp', 'lib/mcp', 'lib/agent', 'lib/kuzmich', 'app/trip-request', 'app/request-status', 'app/seat-request', 'components/booking', 'components/requests', 'app/api/ai/chat'];
function files(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const lines = ROOTS.flatMap(files).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ at: `${f}:${i + 1}`, l })))
  .filter(({ l }) => !/^\s*(\*|\/\/|\/\*)/.test(l));

describe('тексты доверия в контуре заявок', () => {
  it('«временно недоступно/ограничено» — только в запрете агенту или детекторе', () => {
    const bad = lines.filter(({ l }) => /временно (недоступ|огранич)/i.test(l) && !/не пиши|никогда не|re:/i.test(l));
    expect(bad.map((b) => b.at)).toEqual([]);
  });
  it('«мгновенно»/instant — только с отрицанием', () => {
    const bad = lines.filter(({ l }) => /мгновенн|instant|即时/i.test(l) && !/нет|не |без|no instant|nothing|无|没有|не обещай/i.test(l));
    expect(bad.map((b) => b.at)).toEqual([]);
  });
});
