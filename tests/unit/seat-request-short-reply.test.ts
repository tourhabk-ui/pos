/**
 * Пилот «Камчатская рыбалка» (22.10): короткое сообщение оператору под слабую
 * связь и понятный ответ на повторное нажатие.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operatorReplyText } from '@/lib/seat-requests/core';

describe('повторное нажатие', () => {
  it('называет записанный исход', () => {
    expect(operatorReplyText({ ok: false, reason: 'already_answered', status: 'declined' }))
      .toBe('Ответ уже записан: мест нет. Нажимать ещё раз не нужно.');
    expect(operatorReplyText({ ok: false, reason: 'already_answered', status: 'confirmed' }))
      .toBe('Ответ уже записан: места есть, бронь заведена. Нажимать ещё раз не нужно.');
  });
  it('первый ответ ещё обрабатывается', () => {
    expect(operatorReplyText({ ok: false, reason: 'already_answered', status: 'pending' }))
      .toMatch(/уже принят и обрабатывается/);
  });
  it('без статуса — общая фраза', () => {
    expect(operatorReplyText({ ok: false, reason: 'already_answered' }))
      .toBe('На этот запрос уже ответили. Нажимать ещё раз не нужно.');
  });
});

describe('сообщение оператору', () => {
  const src = readFileSync(join(process.cwd(), 'lib/seat-requests/service.ts'), 'utf8');
  it('три строки: заголовок, тур/дата/люди, срок', () => {
    expect(src).toMatch(/'<b>Запрос мест<\/b>',\n\s+what,\n\s+`Ответ до \$\{deadlineLocal\} \(Камчатка\)\. «Есть места» — бронь сразу\.`,\n\s+\]\.join/);
  });
  it('подписи кнопок не менялись', () => {
    expect(src).toMatch(/text: 'Есть места', payload: answerPayload\('yes'/);
    expect(src).toMatch(/text: 'Мест нет', payload: answerPayload\('no'/);
  });
});
