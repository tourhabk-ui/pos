/**
 * Свод мелких находок прогулки оператором (#1804).
 *
 * Каждая по отдельности мелочь, вместе — «кабинет сделан на глаз»: ссылка
 * внутри ссылки роняла гидратацию, кнопка предлагала отправить туда, где нет
 * адресата, тач-цели шапки были вдвое меньше правила, а витрина для операторов
 * обещала втрое больше маршрутов, чем есть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('лиды', () => {
  const list = read('app/hub/operator/leads/_LeadsClient.tsx');
  const detail = read('app/hub/operator/leads/[id]/_LeadDetailClient.tsx');

  it('карточка не оборачивает ссылку в ссылку', () => {
    expect(list).not.toMatch(/<a href=\{`\/hub\/operator\/leads\/\$\{lead\.id\}`\}/);
    expect(list).toMatch(/<Link href=\{`\/hub\/operator\/leads\/\$\{lead\.id\}`\}/);
    // Растянутая область ссылки — псевдоэлементом, действия поверх неё.
    expect(list).toMatch(/before:absolute before:inset-0/);
    expect(list).toMatch(/relative z-10/);
  });

  it('«Отправить клиенту» выключена, когда адресата нет', () => {
    expect(detail).toMatch(/lead\?\.has_recipient === false/);
    expect(detail).toMatch(/отправлять некуда/i);
    expect(read('app/api/leads/[id]/route.ts')).toMatch(/telegram_chat_id IS NOT NULL OR email IS NOT NULL\) AS has_recipient/);
  });

  it('«некуда отправлять» — 409, а не 502 «ошибка шлюза»', () => {
    expect(read('lib/leads/proposal-delivery.ts')).toMatch(/failed\.length > 0 \? 'not_delivered' : 'no_recipient'/);
    expect(read('app/api/leads/[id]/proposal/send/route.ts')).toMatch(/no_recipient: 409/);
  });
});

describe('тач-цели и контраст кабинета', () => {
  it('баннер Telegram: ссылка и «закрыть» не меньше 44 px', () => {
    const banner = read('components/operator/TelegramConnectBanner.tsx');
    expect(banner).toMatch(/min-h-\[44px\]/);
    expect(banner).toMatch(/w-11 h-11/);
    expect(banner).toMatch(/aria-label="Скрыть подсказку"/);
  });

  it('кнопка синхронизации: белый текст на акценте в обеих темах', () => {
    const integrations = read('app/hub/operator/integrations/_IntegrationsPageClient.tsx');
    expect(integrations).toMatch(/bg-\[var\(--accent\)\] text-white/);
    expect(integrations).not.toMatch(/bg-\[var\(--accent\)\] text-\[var\(--bg-card\)\]/);
    expect(integrations).toMatch(/min-h-\[44px\]/);
  });
});

describe('честные цифры и нули', () => {
  it('«1189 маршрутов» заменено значением из базы', () => {
    const client = read('app/operators/join/_JoinClient.tsx');
    const page = read('app/operators/join/page.tsx');
    expect(client).not.toContain('1189');
    expect(page).toMatch(/getPlatformCounts\(\)/);
    // Не смогли посчитать — пункта нет, а не выдуманное число.
    expect(page).toMatch(/routesLine: string \| null = null/);
    expect(client).toMatch(/routesLine \?/);
  });

  it('нули в финансах объясняются словами', () => {
    const finance = read('app/hub/operator/finance/_FinancePageClient.tsx');
    expect(finance).toMatch(/Оплаченных броней в удержании пока нет/);
    expect(finance).toMatch(/Выплат ещё не было/);
    expect(finance).toMatch(/Начисляется с оплаченных броней/);
  });
});
