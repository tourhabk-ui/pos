/**
 * Предложение считается отправленным только если его отправили.
 *
 * До 11.09 канал почты был нарисованным: `sent.push('email_queued')` без
 * единой строки отправки. У лида с почтой и без Telegram это давало непустой
 * список отправленных — функция возвращала успех, лид уходил в
 * `proposal_sent`, оператор читал «Предложение отправлено клиенту». Не
 * отправлялось ничего. Турист ждал письма, которого никто не послал, а лид
 * числился обработанным, и к нему больше не возвращались.
 *
 * Это §4.0 в самом дорогом месте: «не смог» выдавалось за «хорошо», и платил
 * за это живой человек. Отправщик писем в платформе был всё это время
 * (`lib/email.ts`, SMTP Timeweb). Теперь письмо уходит по-настоящему, а
 * сторож держит форму: в «отправлено» почта попадает только по успеху
 * отправщика, отказ пишется в лог, и лид не считается обработанным, если
 * доставки не было.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/leads/proposal-delivery.ts'), 'utf-8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('доставка предложения не выдаёт ненаписанный канал за успех', () => {
  it('письмо реально отправляется, а не помечается отправленным', () => {
    expect(CODE).not.toMatch(/email_queued/);
    expect(CODE).toMatch(/await sendEmail\(\{/);
    expect(CODE).toMatch(/to: lead\.email/);
    // В «отправлено» почта попадает ТОЛЬКО по успеху отправщика.
    expect(CODE).toMatch(/if \(mail\.success\) \{\s*sent\.push\('email'\);/);
    expect(CODE).toMatch(/failed\.push\('email'\)/);
  });

  it('отказ почты не глушится: причина в логе', () => {
    expect(CODE).toMatch(/console\.error\('\[proposal-delivery\] письмо не отправлено'/);
  });

  it('письмо не ушло и Telegram нет — лид не считается обработанным', () => {
    expect(CODE).toMatch(/const emailOnly = sent\.length === 0 && failed\.length === 1 && failed\[0\] === 'email'/);
    expect(CODE).toMatch(/Письмо не ушло, а Telegram у лида нет/);
    // Статус лида возвращается назад — повтор возможен, лид не «обработан».
    expect(CODE).toMatch(/await releaseClaim\(\);/);
  });

  it('если ушло только в Telegram, оператор видит, что письмо не дошло', () => {
    expect(CODE).toMatch(/failed\.includes\('email'\)/);
    expect(CODE).toMatch(/Письмо на почту не ушло/);
  });

  it('успех остаётся успехом, когда канал реально сработал', () => {
    expect(CODE).toMatch(/if \(await tgSend\(lead\.tg_chat_id, text\)\) sent\.push\('telegram'\);/);
    expect(CODE).toMatch(/Предложение отправлено клиенту/);
  });
});

describe('необратимая отметка брони спрашивает подтверждение', () => {
  const DETAIL = readFileSync(join(process.cwd(), 'app/hub/operator/bookings/[id]/_BookingDetailClient.tsx'), 'utf-8');

  it('«Не явился» на карточке брони идёт через диалог, а не с первого касания', () => {
    expect(DETAIL).toMatch(/onClick=\{\(\) => setConfirmNoShow\(true\)\}/);
    expect(DETAIL).toMatch(/Отметить «не явился»\?/);
    expect(DETAIL).toMatch(/Снять её самостоятельно нельзя/);
    expect(DETAIL).not.toMatch(/onClick=\{\(\) => updateStatus\('no_show'\)\}/);
  });

  it('диалог непрозрачный: стекла на действии нет (DS §5)', () => {
    const dialog = DETAIL.slice(DETAIL.indexOf('no-show-title'), DETAIL.indexOf('Не надо'));
    expect(dialog).toMatch(/bg-\[var\(--bg-card\)\]/);
    expect(dialog).not.toMatch(/backdrop-blur/);
  });
});
