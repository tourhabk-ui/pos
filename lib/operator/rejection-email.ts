/**
 * Письмо партнёру об отказе по заявке.
 *
 * Вынесено из роута решения администратора (`PATCH /api/admin/operators/[id]`)
 * вместе с повторной подачей оператора (слово владельца 23.11): гиду и агенту
 * письмо говорило «исправьте и отправьте снова», оператору — ничего, потому
 * что двери у него не было. Теперь дверь есть, и письмо её называет.
 *
 * Имя, название компании и комментарий администратора — текст людей: в HTML
 * письма они идут только через `escapeHtml` (до этого подставлялись как есть).
 */
import { escapeHtml } from '@/lib/text/escape-html';

export interface RejectionEmailInput {
  contactName: string | null;
  companyName: string | null;
  /** `partners.category`: гид, агент или остальные (оператор и прочие). */
  category: string | null;
  /** Комментарий администратора; null — не написан. */
  comment: string | null;
}

/** Что именно не прошло проверку — словами роли, с согласованным глаголом. */
function subjectWords(category: string | null): { what: string; verb: string } {
  if (category === 'agent') return { what: 'профиль агента', verb: 'не прошёл' };
  if (category === 'guide') return { what: 'профиль гида', verb: 'не прошёл' };
  return { what: 'заявка компании', verb: 'не прошла' };
}

/** Куда идти исправлять — у каждой роли своя дверь повторной подачи. */
function nextStep(category: string | null): string {
  if (category === 'guide') return 'Исправьте профиль в кабинете гида и отправьте его на проверку снова.';
  if (category === 'agent') return 'Исправьте профиль в кабинете агента (раздел «Профиль») и отправьте его на проверку снова.';
  if (category === 'operator') return 'Исправьте профиль компании в кабинете (раздел «Профиль») и отправьте заявку на проверку снова.';
  // У остальных ролей заявки с отказом и повторной подачей нет — обещать дверь нечем.
  return '';
}

export function rejectionEmailHtml(input: RejectionEmailInput): string {
  const step = nextStep(input.category);
  const comment = input.comment?.trim() ? input.comment.trim() : null;
  const { what, verb } = subjectWords(input.category);
  return [
    `<p>Здравствуйте, <b>${escapeHtml(input.contactName ?? '')}</b>!</p>`,
    `<p>К сожалению, ${what} <b>${escapeHtml(input.companyName ?? '')}</b> ${verb} проверку.</p>`,
    step ? `<p>${step}</p>` : '',
    comment ? `<p><b>Комментарий:</b> ${escapeHtml(comment)}</p>` : '',
    '<p>По вопросам: <a href="mailto:info@vedarai.ru">info@vedarai.ru</a></p>',
  ].filter(Boolean).join('\n');
}
