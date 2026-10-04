/**
 * Радар (/safety), скрин владельца 04.10: «+7 (4152) 30-10-89» разрывался на
 * две строки, а рядом стояло «Sunny». Номер — одной строкой (переносится
 * подпись), описание погоды — по-русски или никак.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('экстренные контакты радара', () => {
  const src = read('app/safety/_SafetyClient.tsx');
  const at = src.indexOf('EMERGENCY_CONTACTS.map(');
  const block = src.slice(at, src.indexOf('))}', at));

  it('номер не переносится и не сжимается, переносится подпись', () => {
    expect(block).toMatch(/<a href=\{`tel:[^>]*whiteSpace: 'nowrap'/);
    expect(block).toMatch(/<a href=\{`tel:[^>]*flexShrink: 0/);
    expect(block).toMatch(/\{c\.name\}/);
    expect(block).toMatch(/flex: 1, minWidth: 0 \}\}>\{c\.name\}/);
  });
});

describe('погода радара по-русски', () => {
  const route = read('app/api/safety/weather/route.ts');
  it('wttr.in спрашивается с lang=ru', () => {
    expect(route).toContain('format=j1&lang=ru');
  });
  it('английское описание не подставляется запасом', () => {
    expect(route).not.toMatch(/desc:[^\n]*weatherDesc/);
  });
});
