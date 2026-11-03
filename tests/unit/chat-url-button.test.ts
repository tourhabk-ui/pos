/** Дыра 3 (03.11): ссылка подтверждения цен — кнопкой-ссылкой в Telegram и MAX. */
import { describe, it, expect } from 'vitest';
import { menuMarkup } from '@/lib/roles/chat-menu';
import { telegramCabinetMarkup } from '@/lib/rental/cabinet-bar';

const URL_BTN = { text: 'Проверить и подтвердить', payload: 'url', url: 'https://vedarai.ru/hub/operator/pricing/confirm?id=x' };

describe('кнопка-ссылка под ответом кабинета', () => {
  it('Telegram, строка меню роли: url, не callback', () => {
    const kb = menuMarkup([{ text: 'Помощь', payload: 'rm:help' }], [[URL_BTN]]).inline_keyboard;
    expect(kb[0][0]).toEqual({ text: URL_BTN.text, url: URL_BTN.url });
    expect(kb.at(-1)?.[0]).toEqual({ text: 'Помощь', callback_data: 'rm:help' });
  });
  it('Telegram, кабинет проката: url, не callback', () => {
    expect(telegramCabinetMarkup([[URL_BTN]]).inline_keyboard[0][0]).toEqual({ text: URL_BTN.text, url: URL_BTN.url });
  });
  it('MAX: в вебхуке кнопка с url — link', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('app/api/max/kuzmich/route.ts', 'utf8')).toMatch(/b\.url \? \{ type: 'link' as const, text: b\.text, url: b\.url \}/);
  });
});
