/**
 * Прогрев планов после деплоя (аудит 02.10).
 *
 * /plans/[slug] — ISR на сутки, но кэш живёт в контейнере и после каждого
 * деплоя пуст: первый посетитель каждой из 17 страниц ждал 6–8 с. start.js
 * через полторы минуты после старта читает /plans и обходит ссылки по одной.
 * Сторож держит форму: список берётся со страницы, не дублируется; обход
 * последовательный; отказ и пустой список называются в логе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('start.js', 'utf8');
const block = src.match(/\/\/ <warmPlans>([\s\S]*?)\/\/ <\/warmPlans>/)?.[1] ?? '';

describe('start.js: прогрев /plans', () => {
  it('блок на месте и стартует не раньше минуты после запуска', () => {
    expect(block).not.toBe('');
    const delay = Number(block.match(/warmPlans\(\)[\s\S]*?\}, (\d+)\);/)?.[1]);
    expect(delay).toBeGreaterThanOrEqual(60_000);
  });

  it('список планов — со страницы /plans, а не из кода', () => {
    expect(block).toMatch(/fetchLocal\('\/plans', \d+\)/);
    expect(block).toContain('/href="\\/plans\\/([a-z0-9-]+)"/g');
    expect(block).not.toMatch(/presets/);
  });

  it('обход последовательный, через локальный порт с правильным Host', () => {
    expect(block).toMatch(/for \(const slug of slugs\) \{[\s\S]*?await fetchLocal\(`\/plans\/\$\{slug\}`/);
    expect(block).not.toMatch(/Promise\.all/);
    expect(block).toMatch(/'host': '127\.0\.0\.1:3001'/);
  });

  it('третий исход не глушится: отказ хаба, пустой список и каждый отказ — в лог', () => {
    expect(block).toMatch(/\[warm-plans\] \/plans HTTP/);
    expect(block).toMatch(/прогревать нечего/);
    expect(block).toMatch(/\[warm-plans\] \/plans\/\$\{slug\} (HTTP|error)/);
    expect(block).toMatch(/прогрето \$\{ok\} из \$\{slugs\.length\}/);
  });
});
