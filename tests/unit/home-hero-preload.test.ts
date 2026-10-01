/**
 * Фото героя главной предзагружается с высоким приоритетом (аудит 01.10).
 *
 * Элемент LCP мобильной главной — фото героя, а оно задано фоном из CSS:
 * браузер находит его только после разбора стилей. Замер 01.10 (Pixel 7):
 * заголовок отрисован на 2,2 с, фото — на 3,8 с. Предзагрузка ставит фото в
 * очередь вместе с HTML. Путь — та же переменная, что у фона: другой путь
 * означал бы вторую загрузку того же снимка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('app/_home/_HomeV8Client.tsx', 'utf-8');

describe('герой главной', () => {
  it('предзагрузка фото героя с fetchPriority="high"', () => {
    expect(SRC).toMatch(/<link rel="preload" as="image" href=\{heroImg\} fetchPriority="high" \/>/);
  });

  it('фон и предзагрузка берут один и тот же путь', () => {
    expect(SRC).toMatch(/className="hero-photo" style=\{\{ backgroundImage: `url\('\$\{heroImg\}'\)` \}\}/);
    expect(SRC.match(/const heroImg = /g)).toHaveLength(1);
  });
});
