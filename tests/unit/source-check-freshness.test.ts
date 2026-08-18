/**
 * У улики есть возраст — и предмет.
 *
 * План, Ф1: результат сверки сохраняется в базу, потому что иначе правило
 * доверия (Ф2) спросить его не может. Но сохранённый вердикт — не вечный
 * факт: сверка сравнивала нашу копию со страницей НА ТОТ ДЕНЬ.
 *
 * Стережём два свойства, и второе важнее первого:
 *
 *   1. старая проверка становится «пора пересмотреть», а не «подтверждено»;
 *   2. проверка ЧУЖОЙ линии не считается устаревшей — она считается
 *      отсутствующей. Устаревшая улика говорит о том же предмете, а эта — о
 *      другом. Если после сверки геометрию переимпортировали, прежний вердикт
 *      относится к линии, которой больше нет.
 */
import { describe, it, expect } from 'vitest';
import {
  checkFreshness, geometryFingerprint, CHECK_FRESH_DAYS,
} from '@/lib/routes/track-reconcile';

const now = new Date('2026-08-18T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

describe('свежесть сохранённой улики', () => {
  it('свежая проверка той же линии — «current»', () => {
    expect(checkFreshness({ checkedAt: daysAgo(3), geometryHash: 'abc' }, 'abc', now)).toBe('current');
  });

  it('старая проверка — «пора пересмотреть», а не «подтверждено»', () => {
    expect(checkFreshness({ checkedAt: daysAgo(CHECK_FRESH_DAYS + 1), geometryHash: 'abc' }, 'abc', now))
      .toBe('review_due');
  });

  it('проверки не было вовсе — «неизвестно»', () => {
    expect(checkFreshness(null, 'abc', now)).toBe('unknown');
    expect(checkFreshness({ checkedAt: null, geometryHash: null }, 'abc', now)).toBe('unknown');
  });

  it('проверяли ДРУГУЮ линию — улика отсутствует, а не устарела', () => {
    // Геометрию переимпортировали после сверки: прежний вердикт относится к
    // линии, которой больше нет. Назвать это «review_due» значило бы сказать
    // «подтверждение слегка просрочено» там, где подтверждения нет вовсе.
    expect(checkFreshness({ checkedAt: daysAgo(1), geometryHash: 'abc' }, 'xyz', now)).toBe('unknown');
  });
});

describe('отпечаток линии', () => {
  const line = (n: number, shift = 0) =>
    Array.from({ length: n }, (_, i) => [158.4 + shift + i * 0.001, 53.25 + i * 0.001]);

  it('одна и та же линия даёт один отпечаток', () => {
    expect(geometryFingerprint(line(50))).toBe(geometryFingerprint(line(50)));
  });

  it('изменённая линия даёт другой отпечаток', () => {
    expect(geometryFingerprint(line(50))).not.toBe(geometryFingerprint(line(51)));
    expect(geometryFingerprint(line(50))).not.toBe(geometryFingerprint(line(50, 0.01)));
  });

  it('пустая линия отпечатывается без падения', () => {
    expect(typeof geometryFingerprint([])).toBe('string');
  });
});
