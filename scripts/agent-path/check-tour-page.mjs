#!/usr/bin/env node
/**
 * scripts/agent-path/check-tour-page.mjs — проба пути агента-браузера на проде,
 * ТОЛЬКО ЧТЕНИЕ (#2968, 03.11).
 *
 * Открывает карточку тура так, как её открывает агент по ReserveAction:
 * `/catalog/tours/<slug>?date=…&guests=…#booking`, без JavaScript, и проверяет
 * серверный HTML: форма заявки есть, дата и число людей подставлены, поля
 * подписаны, капчи нет, ReserveAction на тот же адрес, «заявка — не бронь».
 * Заявку НЕ отправляет: на проде она легла бы в CRM и аналитику как настоящая.
 *
 * Правила проверки — `checkAgentTourHtml`; её же зовёт CI на HTML, который
 * рендерит настоящая страница (tests/unit/agent-browser-path.test.tsx), так
 * что проба и сторож судят одним правилом.
 *
 * Запуск: node scripts/agent-path/check-tour-page.mjs [https://vedarai.ru]
 * Тур берётся первым из каталога; дата — через 30 дней по UTC, людей 2.
 * Исход: 0 — всё на месте; 1 — чего-то нет (список в выводе); 2 — не смог
 * проверить (сеть, нет туров в каталоге) — это не «хорошо».
 */

const LABELLED = ['booking-participants', 'booking-name', 'booking-phone', 'booking-email'];

/** @returns {{ check: string, ok: boolean, detail?: string }[]} */
export function checkAgentTourHtml(html, { slug, date, guests, base = 'https://vedarai.ru' }) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok, ...(detail ? { detail } : {}) });
  const bookingOpen = /<div[^>]*\bid="booking"[^>]*>/.exec(html);
  add('форма заявки (#booking)', Boolean(bookingOpen));
  add('адрес тура в HTML (data-tour-slug)', Boolean(bookingOpen && bookingOpen[0].includes(`data-tour-slug="${slug}"`)));
  add('«Заявка — не бронь»', html.includes('Заявка — не бронь'));
  const dateInput = /<input[^>]*\bid="booking-date-value"[^>]*>/.exec(html)?.[0] ?? '';
  add('дата подставлена', dateInput.includes(`value="${date}"`), dateInput ? undefined : 'нет поля booking-date-value');
  const select = /<select[^>]*\bid="booking-participants"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
  add('число людей подставлено', new RegExp(`<option[^>]*value="${guests}"[^>]*selected|<option[^>]*selected[^>]*value="${guests}"`).test(select));
  for (const id of LABELLED) add(`поле ${id} подписано`, html.includes(`for="${id}"`) && html.includes(`id="${id}"`));
  add('капчи нет', !/captcha|recaptcha|hcaptcha|turnstile/i.test(html));
  const template = `${base}/catalog/tours/${slug}?date={date}&guests={guests}#booking`;
  const lds = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let action = null;
  for (const raw of lds) {
    try { const j = JSON.parse(raw); if (j && j.potentialAction) action = j.potentialAction; } catch { /* битый JSON-LD — ниже «нет ReserveAction» */ }
  }
  add('ReserveAction на этот адрес', Boolean(action && action['@type'] === 'ReserveAction' && action.target?.urlTemplate === template),
    action ? `urlTemplate: ${action.target?.urlTemplate ?? 'нет'}` : 'JSON-LD без potentialAction');
  return out;
}

async function main() {
  const base = (process.argv[2] || 'https://vedarai.ru').replace(/\/$/, '');
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const guests = 2;
  let slug;
  try {
    const catalog = await fetch(`${base}/catalog`, { signal: AbortSignal.timeout(60000) });
    const page = await catalog.text();
    slug = /href="\/catalog\/tours\/([a-z0-9][a-z0-9-]{1,120})"/.exec(page)?.[1];
    if (!slug) { console.log(`НЕ СМОГ ПРОВЕРИТЬ: в /catalog (HTTP ${catalog.status}) нет ссылки на тур.`); process.exit(2); }
  } catch (e) {
    console.log(`НЕ СМОГ ПРОВЕРИТЬ: /catalog не открылся — ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const url = `${base}/catalog/tours/${slug}?date=${date}&guests=${guests}`;
  let res, html;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'vedar-agent-path-probe' } });
    html = await res.text();
  } catch (e) {
    console.log(`НЕ СМОГ ПРОВЕРИТЬ: ${url} не открылся — ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log(`${url}#booking — HTTP ${res.status}, ${html.length} знаков`);
  if (res.status !== 200) { console.log('ПЛОХО: страница тура не отдала 200.'); process.exit(1); }
  const checks = checkAgentTourHtml(html, { slug, date, guests, base });
  for (const c of checks) console.log(`${c.ok ? 'да ' : 'НЕТ'}  ${c.check}${c.detail ? ` (${c.detail})` : ''}`);
  const bad = checks.filter((c) => !c.ok);
  console.log(bad.length ? `ПЛОХО: не на месте ${bad.length} из ${checks.length}.` : `ХОРОШО: все ${checks.length} на месте. Заявка не отправлялась.`);
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
