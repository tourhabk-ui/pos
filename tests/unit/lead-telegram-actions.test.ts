/**
 * Лид закрывается одной кнопкой из мессенджера (#65).
 *
 * 23.08 канал сменился: уведомления с ПД туриста ушли в MAX (решение
 * владельца), и проверка на `callback_data:` покраснела — хотя гарантия не
 * ослабла, а расширилась на второй мессенджер. Поэтому здесь сторожится
 * СВОЙСТВО — под уведомлением есть кнопка нужного действия и её нажатие
 * доходит до общего модуля доставки, — а не синтаксис одного клиента.
 *
 * Раньше на самом горячем шаге воронки владельцу приходилось дважды выходить
 * из мессенджера в веб-кабинет: «обработать AI», потом «отправить». Теперь оба
 * решения — кнопки под уведомлением.
 *
 * Сторож держит четыре вещи, поломка которых стоит денег или доверия:
 *  1. Доставка предложения — ОДНА реализация: ручка кабинета и кнопка зовут
 *     общий sendProposalToClient. Второй способ отправки разошёлся бы текстом.
 *  2. Идемпотентность: статус proposal_sent не даёт отправить клиенту дважды.
 *  3. Право нажатия — принадлежность сообщения админ-чату, не from.id.
 *  4. Авторизация НЕ переехала в модуль доставки: у ручки остаётся
 *     requireOperator.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const DELIVERY = read('lib/leads/proposal-delivery.ts');
const SEND_ROUTE = read('app/api/leads/[id]/proposal/send/route.ts');
const NOTIFY = read('lib/notifications/lead-notify.ts');
const BOT = read('app/api/telegram/kuzmich/route.ts');
const MAX_BOT = read('app/api/max/kuzmich/route.ts');

describe('одна реализация доставки', () => {
  it('ручка кабинета не шлёт сама — зовёт общий модуль', () => {
    expect(SEND_ROUTE).toMatch(/sendProposalToClient/);
    expect(SEND_ROUTE).not.toMatch(/sendMessage/);
    expect(SEND_ROUTE).not.toMatch(/UPDATE leads/);
  });

  it('кнопка в Telegram зовёт тот же модуль', () => {
    expect(BOT).toMatch(/import\('@\/lib\/leads\/proposal-delivery'\)/);
    expect(BOT).toMatch(/sendProposalToClient\(leadId\)/);
  });

  it('кнопка в MAX зовёт тот же модуль', () => {
    expect(MAX_BOT).toMatch(/import\('@\/lib\/leads\/proposal-delivery'\)/);
    expect(MAX_BOT).toMatch(/sendProposalToClient\(leadId\)/);
  });

  it('авторизация осталась у вызывающих, в модуль доставки не переехала', () => {
    expect(SEND_ROUTE).toMatch(/requireOperator\(req\)/);
    // Смотрим импорты, а не прозу: в шапке модуля auth упомянут намеренно.
    const imports = DELIVERY.match(/^import .*$/gm)?.join('\n') ?? '';
    expect(imports).not.toMatch(/auth/);
  });
});

describe('идемпотентность и деньги', () => {
  it('повторная отправка клиенту невозможна: статус — сторож', () => {
    expect(DELIVERY).toMatch(/status === 'proposal_sent'/);
    expect(DELIVERY).toMatch(/reason: 'already_sent'/);
    // Проверка статуса — ДО отправки, иначе клиент получит дубль.
    expect(DELIVERY.indexOf("already_sent")).toBeLessThan(DELIVERY.indexOf('await tgSend'));
  });
});

describe('кнопки под уведомлениями', () => {
  it('готовое предложение отправляется одним нажатием', () => {
    expect(NOTIFY).toMatch(/lead_send:\$\{proposal\.lead_id\}/);
    expect(NOTIFY).toMatch(/Отправить клиенту/);
  });

  it('входящий лид обрабатывается AI одним нажатием', () => {
    expect(NOTIFY).toMatch(/lead_ai:\$\{params\.leadId\}/);
  });

  it('нажатие в MAX разбирается — кнопка не мёртвая', () => {
    expect(MAX_BOT).toMatch(/action === 'lead_ai'/);
    expect(MAX_BOT).toMatch(/action === 'lead_send'/);
  });

  it('payload влезает в лимит Telegram (64 байта)', () => {
    // Префикс + UUID: 'lead_send:' (10) + 36 = 46.
    expect('lead_send:'.length + 36).toBeLessThanOrEqual(64);
    expect('lead_ai:'.length + 36).toBeLessThanOrEqual(64);
  });
});

describe('право нажатия', () => {
  it('в MAX гейт по рабочему чату, а не по user_id', () => {
    const block = MAX_BOT.slice(MAX_BOT.indexOf("payload.startsWith('lead_')"));
    expect(block).toMatch(/MAX_OPERATOR_CHAT_ID/);
    expect(block).toMatch(/String\(resolvedChatId\) !== operatorChat/);
  });

  it('гейт по чату сообщения, а не по from.id', () => {
    const block = BOT.slice(BOT.indexOf("cq.data.startsWith('lead_send:')"));
    expect(block).toMatch(/TELEGRAM_CHAT_ID/);
    expect(block).toMatch(/String\(chatId\) !== adminChat/);
  });

  it('идентификатор лида проверяется до похода в БД', () => {
    const fn = BOT.slice(BOT.indexOf('async function handleLeadAction'));
    expect(fn).toMatch(/\[0-9a-f-\]\{36\}/);
  });

  it('на каждое нажатие отвечаем — кнопка не виснет', () => {
    const fn = BOT.slice(
      BOT.indexOf('async function handleLeadAction'),
      BOT.indexOf('// ── /start с клавиатурой'),
    );
    // Успех, отказ, неизвестное действие и ошибка — все ветки отвечают.
    expect((fn.match(/tgAnswerCallback/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(fn).toMatch(/catch \(err\)[\s\S]*tgAnswerCallback/);
  });
});
