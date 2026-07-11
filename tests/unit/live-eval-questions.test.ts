/**
 * tests/unit/live-eval-questions.test.ts
 *
 * Живая выборка вопросов для faithfulness-регрессии: PII-маскинг
 * (телефоны/email/telegram), фильтр eval-пригодности, дедуп и нарезка.
 * Ключевой контракт: ни телефон, ни email не доживают до eval-отчёта.
 */

import { describe, it, expect } from 'vitest';
import { maskPII, isEvalWorthy, toEvalQuestions } from '@/lib/agents/eval/live-questions';

describe('maskPII', () => {
  it('маскирует телефоны в разных форматах', () => {
    expect(maskPII('Позвоните мне +7 962 215-33-44 после обеда')).not.toContain('215-33-44');
    expect(maskPII('мой номер 8 (962) 215 33 44')).not.toContain('215 33 44');
    expect(maskPII('тел +79622153344')).not.toContain('9622153344');
    expect(maskPII('Позвоните +7 962 215-33-44')).toContain('[телефон]');
  });

  it('маскирует email и telegram-хэндлы', () => {
    expect(maskPII('пишите на ivan.petrov@example.com')).toContain('[email]');
    expect(maskPII('мой телеграм @ivan_petrov')).toContain('[контакт]');
    expect(maskPII('пишите на ivan.petrov@example.com')).not.toContain('example.com');
  });

  it('не трогает обычный текст, числа и цены', () => {
    const text = 'Тур на Мутновский за 15000 рублей на 3 дня в августе';
    expect(maskPII(text)).toBe(text);
  });

  it('не считает год или высоту телефоном', () => {
    const text = 'Высота Ключевской 4750 м, извержение 2023 года';
    expect(maskPII(text)).toBe(text);
  });
});

describe('isEvalWorthy', () => {
  it('пропускает нормальные вопросы', () => {
    expect(isEvalWorthy('Какая погода на Авачинском в августе?')).toBe(true);
    expect(isEvalWorthy('что взять с собой на Толбачик')).toBe(true);
  });

  it('отсекает команды, приветствия и мусор', () => {
    expect(isEvalWorthy('/start')).toBe(false);
    expect(isEvalWorthy('привет')).toBe(false);
    expect(isEvalWorthy('Здравствуйте!')).toBe(false);
    expect(isEvalWorthy('спасибо')).toBe(false);
    expect(isEvalWorthy('да')).toBe(false);
    expect(isEvalWorthy('123456789012345')).toBe(false);
    expect(isEvalWorthy('коротко')).toBe(false);
    expect(isEvalWorthy('а'.repeat(301))).toBe(false);
    expect(isEvalWorthy('')).toBe(false);
  });
});

describe('toEvalQuestions', () => {
  it('маскирует, фильтрует, дедупит и режет по лимиту', () => {
    const raw = [
      'Какая погода на Авачинском в августе?',
      'какая погода на  Авачинском в августе?', // дубль с другим регистром/пробелами
      '/start',
      'привет',
      'Мой телефон +7 962 215-33-44, подберите тур на вулканы',
      'Где увидеть медведей на Курильском озере?',
      'Сколько стоит вертолёт в Долину гейзеров?',
    ];
    const out = toEvalQuestions(raw, 3);
    expect(out).toHaveLength(3);
    expect(out.map((q) => q.category)).toEqual(['live', 'live', 'live']);
    expect(out.map((q) => q.id)).toEqual(['live-1', 'live-2', 'live-3']);
    // Дубль не прошёл
    const texts = out.map((q) => q.question.toLowerCase().replace(/\s+/g, ' '));
    expect(new Set(texts).size).toBe(texts.length);
    // Телефон замаскирован ещё до попадания в вопрос
    const withPhone = toEvalQuestions([raw[4]!], 1);
    expect(withPhone[0]!.question).toContain('[телефон]');
    expect(withPhone[0]!.question).not.toContain('215-33-44');
  });

  it('пустой вход — пустой выход', () => {
    expect(toEvalQuestions([], 10)).toEqual([]);
  });
});
