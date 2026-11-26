/**
 * Письмо партнёру об одобрении заявки.
 *
 * Вынесено из роута решения администратора (`PATCH /api/admin/operators/[id]`)
 * рядом с письмом об отказе (`lib/operator/rejection-email`). Повод — ревью
 * безопасности 23.11 (PR #3801): письмо об отказе имя и название компании уже
 * экранировало, а письмо об одобрении подставляло их в HTML как есть.
 *
 * Имя и название компании — текст людей: в HTML письма они идут только через
 * `escapeHtml`. Слова письма не менялись.
 */
import { escapeHtml } from '@/lib/text/escape-html';

export interface ApprovalEmailInput {
  contactName: string | null;
  companyName: string | null;
  /** `partners.category`: гид, агент или остальные (оператор и прочие). */
  category: string | null;
  /** `partners.id` — для ссылки на публичный профиль гида. */
  partnerId: string;
}

export function approvalEmailSubject(category: string | null): string {
  if (category === 'agent') return 'Кабинет агента открыт — Ведар';
  if (category === 'guide') return 'Профиль гида одобрен — Ведар';
  return 'Ваша заявка одобрена — TourHub';
}

export function approvalEmailHtml(input: ApprovalEmailInput): string {
  const hello = `<p>Здравствуйте, <b>${escapeHtml(input.contactName ?? '')}</b>!</p>`;
  const company = `<b>${escapeHtml(input.companyName ?? '')}</b>`;
  if (input.category === 'agent') {
    return [
      hello,
      `<p>Профиль агента ${company} проверен и одобрен. Теперь вы можете оформлять брони для клиентов, делиться реферальными ссылками и запрашивать выплату вознаграждения.</p>`,
      '<p><a href="https://vedarai.ru/hub/agent">Перейти в кабинет агента →</a></p>',
    ].join('\n');
  }
  if (input.category === 'guide') {
    return [
      hello,
      `<p>Профиль гида ${company} проверен и одобрен. Теперь он виден туристам в реестре гидов.</p>`,
      // Id карточки — из базы, но в адрес идёт только закодированным.
      `<p><a href="https://vedarai.ru/guides/${encodeURIComponent(input.partnerId)}">Открыть профиль на сайте →</a></p>`,
    ].join('\n');
  }
  return [
    hello,
    `<p>Заявка компании ${company} одобрена. Теперь вы можете публиковать туры.</p>`,
    '<p><a href="https://vedarai.ru/hub/operator">Перейти в кабинет →</a></p>',
  ].join('\n');
}
