/**
 * Четвёртый заход аудита 21.11.2026 (сверка Гло на проде 3834bf0f):
 * оставшиеся превосходные степени п. 29 и 31 и мелочи /chto-posmotret-na-kamchatke.
 */
import { describe, it, expect } from 'vitest';
import { landingBySlug } from '@/lib/landings/landings';

const body = (slug: string) => {
  const l = landingBySlug(slug);
  expect(l, slug).toBeTruthy();
  return `${l.before}\n${l.after}`;
};

describe('п. 29 /morskie-progulki-kamchatka', () => {
  it('старт прогулок без «самого популярного места»; косатка атрибутирована Википедии', () => {
    const text = body('morskie-progulki-kamchatka');
    expect(text).toMatch(/Прогулки обычно начинаются в Петропавловске-Камчатском и проходят через Авачинскую бухту/);
    expect(text).not.toMatch(/Самое популярное место старта — Петропавловск-Камчатский/);
    expect(text).not.toMatch(/все маршруты проходят через Авачинскую бухту/);
    expect(text).toMatch(/По данным Википедии, косатка — крупнейший представитель семейства дельфиновых/);
    expect(text).toContain('wikipedia.org/wiki/Косатка_(млекопитающее)');
  });
});

describe('п. 31 /kamchatskaya-kukhnya-gde-poest', () => {
  it('без «лучше всех», «главное лакомство» и «лучше всего передаёт аромат»', () => {
    const text = body('kamchatskaya-kukhnya-gde-poest');
    expect(text).toMatch(/Ительмены, по словам портала, умеют готовить нерку/);
    expect(text).not.toMatch(/лучше всех знают, как готовить/);
    expect(text).toMatch(/по словам портала, лакомство коренных народов/);
    expect(text).not.toMatch(/главное лакомство коренных народов/);
    expect(text).toMatch(/портал называет напитком, который передаёт аромат полуострова/);
    expect(text).not.toMatch(/лучше всего передаёт аромат полуострова/);
  });
});

describe('мелочи /chto-posmotret-na-kamchatke', () => {
  it('без «главного медвежьего места» и «самых знаменитых» Дачных; FAQ 4750 м со ссылкой на KVERT', () => {
    const text = body('chto-posmotret-na-kamchatke');
    expect(text).toMatch(/Курильское озеро в Южно-Камчатском заказнике: с июля по сентябрь там массовый нерест лосося и крупная группировка бурых медведей/);
    expect(text).not.toMatch(/Главное «медвежье» место/);
    expect(text).toMatch(/\*\*Дачные источники\.\*\* Горячие источники на пути к вулканам, с голубой глиной/);
    expect(text).not.toMatch(/Самые знаменитые из десятков горячих источников/);
    const faq = text.split('Какой самый высокий вулкан Камчатки?')[1] ?? '';
    const ans = faq.split('**Когда лучше ехать')[0];
    expect(ans).toMatch(/Ключевская сопка, 4750 м \(KVERT, ИВиС ДВО РАН\) \[13\]/);
    expect(text).toContain('kvert.febras.net/volc?lang=ru&name=Klyuchevskoy');
  });
});
