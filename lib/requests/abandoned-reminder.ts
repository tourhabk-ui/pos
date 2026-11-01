/**
 * Возврат брошенной заявки (02.11, ЧЕРНОВИК до утверждения текста согласия).
 * Правила: одно напоминание на черновик; только при отдельном согласии на
 * повторный контакт (lib/legal/recontact-consent.ts); заявку отправляет сам
 * человек кнопкой, подтверждает её человек-партнёр; оплаты и мгновенной брони
 * нет. Telegram — без персональных данных (pd-guard): ни имени, ни телефона,
 * ни дат/состава — только обезличенная ссылка. MAX — то же плюс название.
 */
import { RECONTACT_CONSENT_VERSION } from '@/lib/legal/recontact-consent';

export type ReminderChannel = 'max' | 'telegram';
export interface AbandonedDraft {
  createdAt: Date;
  submittedAt: Date | null;
  remindersSent: number;
  recontactConsentVersion: string | null;
  recontactWithdrawn: boolean;
  channel: ReminderChannel | null;
  resumeToken: string;
  title: string | null; // тур/жильё — без ПД
}

export const REMIND_AFTER_MS = 60 * 60_000;      // не раньше часа
export const REMIND_UNTIL_MS = 72 * 60 * 60_000; // и не позже трёх суток

export function reminderDue(d: AbandonedDraft, now = new Date()): boolean {
  if (d.submittedAt || d.remindersSent > 0 || d.recontactWithdrawn || !d.channel) return false;
  if (d.recontactConsentVersion !== RECONTACT_CONSENT_VERSION) return false;
  const age = now.getTime() - d.createdAt.getTime();
  return age >= REMIND_AFTER_MS && age <= REMIND_UNTIL_MS;
}

export function buildReminder(d: AbandonedDraft, base: string): { text: string; button: { label: string; url: string } } {
  const url = `${base.replace(/\/$/, '')}/request-resume#${d.resumeToken}`;
  const what = d.channel === 'max' && d.title ? ` («${d.title.slice(0, 80)}»)` : '';
  return {
    text: `Вы начали заявку${what}, но не отправили её. Если ещё актуально — отправьте одной кнопкой; подтвердит человек, оплаты через платформу нет. Это единственное напоминание.\nEN: You started a request but did not send it. One reminder only. ZH: 您有一个未提交的申请，仅提醒一次。`,
    button: { label: 'Отправить заявку', url },
  };
}
