/**
 * Кнопка «Операторы» и команда /operators в Telegram — список компаний витрины.
 *
 * До 24.10 здесь был свой запрос `partners WHERE is_public LIMIT 10`.
 * Перевозчик и прокат, который сайт прячет паузой, шли под заголовком
 * «Операторы на Ведаре». Партнёр без адреса давал ссылку /operators/null.
 * Что показаны первые десять, не говорилось, а отказ базы глушил пустой
 * catch (находка 24.10).
 *
 * Теперь отбор и порядок — витрины /operators (`queryOperatorLinks`), правило
 * порядка названо его же словами, неполный список назван неполным, отказ базы
 * — «не загрузился» и SQLSTATE в лог (§4.0).
 */

import { sqlState } from '@/lib/guides/db-failure';
import { queryOperatorLinks } from '@/lib/operators/list-query';
import { OPERATORS_ORDER_NOTE } from '@/lib/operators/order-note';
import { RENTAL_SITE_PAUSE, rentalHiddenOnSite } from '@/lib/rental/site-pause';
import { escapeHtml } from '@/lib/text/escape-html';

/** Сколько компаний называем в чате. Остальные — на /operators. */
export const OPERATORS_IN_CHAT = 10;

const SITE = 'https://vedarai.ru';

export async function touristOperatorsList(now: Date = new Date()): Promise<string> {
  const hidden = RENTAL_SITE_PAUSE.slugs.filter((slug) => rentalHiddenOnSite(slug, now));
  let found: { items: Array<{ name: string; slug: string }>; total: number };
  try {
    found = await queryOperatorLinks(OPERATORS_IN_CHAT, hidden);
  } catch (err) {
    console.error(
      `[telegram/operators] список компаний не прочитан: sqlstate=${sqlState(err)}`,
      err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    );
    return `Список компаний сейчас не загрузился — это сбой, а не пустой список. Все компании — на сайте: <a href="${SITE}/operators">vedarai.ru/operators</a>`;
  }
  if (found.items.length === 0) {
    return 'На витрине Ведара пока нет ни одной компании.';
  }
  const head = found.total > found.items.length
    ? `<b>Операторы на Ведаре</b> — первые ${found.items.length} из ${found.total}.`
    : `<b>Операторы на Ведаре</b> — все ${found.total}.`;
  const lines = found.items.map((p) => (
    `<a href="${SITE}/operators/${encodeURIComponent(p.slug)}">${escapeHtml(p.name)}</a>`
  ));
  return [
    head,
    OPERATORS_ORDER_NOTE,
    '',
    ...lines,
    '',
    `<a href="${SITE}/operators">Все компании на сайте →</a>`,
  ].join('\n');
}
