/**
 * Заглушка отказа не сохраняется как контент, который прочитает человек.
 *
 * Находка аудита 08.09: отказ ВСЕХ AI-провайдеров приходит СТРОКОЙ, а не
 * исключением, и потребители проверяли её одной длиной.
 *
 *   'Извините, сервис временно недоступен. Попробуйте позже.'  — 54 символа
 *   Editor:      MIN_GENERATION_LENGTH = 40   → проходит
 *   Обогатитель: trimmed.length < 30          → проходит
 *
 * То есть при отказе провайдеров туристу сохранялось описание маршрута или
 * заметка Кузьмича о месте, состоящая из слов «сервис временно недоступен».
 *
 * Реестр заглушек на платформе ОДИН и его шапка прямо требует сверяться с
 * ним: «Роуты ОБЯЗАНЫ проверять ответ этим хелпером». Девять мест требование
 * выполняли, эти два — нет. Правило, записанное в одном месте и не
 * исполняемое в другом, — ровно тот род расхождения, ради которого затевался
 * аудит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isWaterfallErrorResponse, AI_FAST_UNAVAILABLE } from '@/lib/ai/providers';
import { MIN_GENERATION_LENGTH, pickDescriptionFromAnswer } from '@/lib/agents/editor';

const STUB_LONG = 'Извините, сервис временно недоступен. Попробуйте позже.';

describe('почему длины было мало', () => {
  it('длинная заглушка ДЛИННЕЕ порога Editor — одна длина её не ловит', () => {
    expect(STUB_LONG.length).toBeGreaterThan(MIN_GENERATION_LENGTH);
    expect(STUB_LONG.length).toBeGreaterThan(30);
  });

  it('реестр заглушек её опознаёт — было чем судить', () => {
    expect(isWaterfallErrorResponse(STUB_LONG)).toBe(true);
    expect(isWaterfallErrorResponse(AI_FAST_UNAVAILABLE)).toBe(true);
    expect(isWaterfallErrorResponse('Авачинский вулкан виден из города.')).toBe(false);
  });
});

describe('Editor не сохраняет заглушку как описание', () => {
  it('длинная заглушка отбрасывается и причина названа', () => {
    const out = pickDescriptionFromAnswer(STUB_LONG);
    expect(out.text).toBeNull();
    expect(out.failReason).toContain('заглушка водопада');
  });

  it('короткая заглушка тоже отбрасывается', () => {
    expect(pickDescriptionFromAnswer(AI_FAST_UNAVAILABLE).text).toBeNull();
  });

  it('настоящее описание проходит', () => {
    const real = 'Подъём на Авачинский занимает восемь часов; ночёвка на базе у подножия, старт до рассвета.';
    expect(pickDescriptionFromAnswer(real).text).toBe(real);
  });

  it('проверка заглушки стоит ДО проверки длины', () => {
    const SRC = readFileSync('lib/agents/editor.ts', 'utf8');
    const fn = SRC.slice(SRC.indexOf('export function pickDescriptionFromAnswer'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('isWaterfallErrorResponse'))
      .toBeLessThan(body.indexOf('MIN_GENERATION_LENGTH'));
  });
});

describe('заметка Кузьмича о месте — тем же реестром', () => {
  const SRC = readFileSync('lib/agents/kuzmich-place-enricher.ts', 'utf8');

  it('обогатитель сверяется с реестром, а не только с длиной', () => {
    expect(SRC).toContain("from '@/lib/ai/providers'");
    expect(SRC).toMatch(/if \(isWaterfallErrorResponse\(trimmed\)\)/);
  });

  it('своего списка заглушек не заводит', () => {
    expect(SRC).not.toContain("'Сервис временно недоступен'");
  });

  it('отказ пишется в лог, а не глотается пустым catch', () => {
    expect(SRC).toContain("logSwallowedFailure('kuzmich-place-enricher'");
  });
});
