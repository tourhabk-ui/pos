/**
 * Отдельное согласие на ПОВТОРНЫЙ контакт (02.11, решение владельца): одно
 * напоминание о неотправленной заявке. Не входит в согласие на передачу
 * оператору (lib/legal/pd-consent.ts) и не подменяет его: галочка своя,
 * версия своя, по умолчанию не стоит. Текст утверждён владельцем 01.11
 * (вместе со ссылкой на политику — тот же узел, что у основного согласия).
 */
export const RECONTACT_CONSENT_VERSION = '2026-11-01-recontact-v1';

export const RECONTACT_CONSENT_TEXT = {
  ru: 'Согласен, чтобы Ведар один раз напомнил мне о неотправленной заявке в выбранном мессенджере и для этого обработал мой контакт в нём. Напоминание — одно, без рекламы; заявка никому не передаётся, пока я сам её не отправлю. Согласие можно отозвать в любой момент.',
  en: 'I agree that Vedar may remind me once about my unsent request in the messenger I chose, and process my contact there for that purpose. One reminder only, no advertising; the request is not passed to anyone until I send it myself. I can withdraw this consent at any time.',
  zh: '我同意 Vedar 通过我选择的通讯软件就我未提交的申请提醒我一次，并为此处理我在该软件中的联系方式。仅提醒一次，不含广告；在我亲自提交之前，申请不会转交任何人。我可随时撤回此同意。',
} as const;

/** Ссылка на политику — та же, что у основного согласия (PdConsentCheckbox). */
export { PD_CONSENT_POLICY_URL as RECONTACT_POLICY_URL } from '@/lib/legal/pd-consent';

/** Отдельная фраза со ссылкой после утверждённого текста: before + [link] + end. */
export const RECONTACT_POLICY_LINK = {
  ru: { before: 'Обработка — в соответствии с', link: 'политикой конфиденциальности', end: '.' },
  en: { before: 'Processing follows the', link: 'privacy policy', end: '.' },
  zh: { before: '处理依据', link: '隐私政策', end: '。' },
} as const;

export type RecontactLang = keyof typeof RECONTACT_CONSENT_TEXT;
