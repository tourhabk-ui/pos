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
  // До 08.10 радар брал wttr.in и следил за lang=ru: без него стояло «Sunny».
  // Теперь это тот же прогноз, что у Кузьмича и /weather (решение владельца
  // 08.10): описание — из нашего же справочника кодов, по-русски по построению.
  // Код без комментариев: в шапке роута wttr.in назван как прошлое.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const route = code(read('app/api/safety/weather/route.ts'));
  const widget = code(read('lib/weather/safety-widget.ts'));
  it('источник — прогноз платформы, не wttr.in', () => {
    expect(route).toMatch(/fetchForecastDays\(/);
    expect(route).not.toMatch(/wttr\.in/);
  });
  it('слова — правилами weather-format и day-parts, своих нет', () => {
    expect(widget).toMatch(/from '@\/lib\/weather\/weather-format'/);
    expect(widget).toMatch(/partPrecip\(part\)/);
    expect(widget).not.toMatch(/weatherDesc|lang_ru/);
  });
});
