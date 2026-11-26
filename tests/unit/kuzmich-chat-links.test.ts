import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chatBlocks, chatLinkChunks } from '@/lib/kuzmich/chat-links';

// 03.10, скрин владельца: «ссылка в чате не активная».
describe('ссылки в ответе Кузьмича', () => {
  it('свой адрес — внутренний путь, точка в конце не входит в ссылку', () => {
    const c = chatLinkChunks('Ссылка на маршрут: https://vedarai.ru/routes/66061e18-77ba-433f-b812-81e138266b2e.\nДальше текст');
    expect(c[1]).toEqual({ text: 'https://vedarai.ru/routes/66061e18-77ba-433f-b812-81e138266b2e', href: '/routes/66061e18-77ba-433f-b812-81e138266b2e' });
    expect(c[2].text).toBe('.\nДальше текст');
  });

  it('чужой адрес — внешняя ссылка; скобка вокруг не входит', () => {
    const c = chatLinkChunks('МЧС (https://forms.mchs.gov.ru/registration_tourist_groups) — форма');
    expect(c[1]).toMatchObject({ href: 'https://forms.mchs.gov.ru/registration_tourist_groups', external: true });
    expect(c[2].text.startsWith(')')).toBe(true);
  });

  it('скобка внутри адреса остаётся', () => {
    const c = chatLinkChunks('см. https://ru.wikipedia.org/wiki/Горелый_(вулкан)');
    expect(c[1].text).toBe('https://ru.wikipedia.org/wiki/Горелый_(вулкан)');
  });

  it('подписанная ссылка на чужой хост под видом своего пути ссылкой не становится (26.11)', () => {
    // Проверка безопасности ИИ-части 26.11: «/\evil» браузер читает как «//evil».
    for (const target of ['/\\evil.example/pay', '//evil.example/pay', '/\\/evil.example']) {
      const c = chatLinkChunks(`Готово: [Оплата на vedarai.ru](${target}) — по ссылке`);
      expect(c.some((x) => x.href !== undefined), `адрес ${target}`).toBe(false);
    }
    // Свой путь по-прежнему ссылка.
    expect(chatLinkChunks('[Тур](/catalog/tours/12)')).toEqual([{ text: 'Тур', href: '/catalog/tours/12' }]);
  });

  it('свой хост с путём из двух косых остаётся полным адресом на нашем хосте', () => {
    const md = chatLinkChunks('[Оплата](https://vedarai.ru//evil.example/pay)');
    expect(md[0]).toEqual({ text: 'Оплата', href: 'https://vedarai.ru//evil.example/pay' });
    const plain = chatLinkChunks('см. https://vedarai.ru//evil.example');
    expect(plain[1]).toEqual({ text: 'https://vedarai.ru//evil.example', href: 'https://vedarai.ru//evil.example' });
    // Обычный свой адрес — путь, как раньше.
    expect(chatLinkChunks('https://vedarai.ru/places/x')[0]).toEqual({ text: 'https://vedarai.ru/places/x', href: '/places/x' });
  });

  it('не http(s) ссылкой не становится; текст без ссылок — один кусок', () => {
    expect(chatLinkChunks('javascript:alert(1)').every(c => !c.href)).toBe(true);
    expect(chatLinkChunks('просто текст')).toEqual([{ text: 'просто текст' }]);
  });

  it('пункты с новой строки становятся списком, обычный текст — нет', () => {
    expect(chatBlocks('Сезон короткий.\n- берег\n- сопка\n\nДень 1 — переход')).toEqual([
      { kind: 'text', text: 'Сезон короткий.' },
      { kind: 'list', items: ['берег', 'сопка'] },
      { kind: 'text', text: 'День 1 — переход' },
    ]);
    expect(chatBlocks('1. первое\n2) второе')).toEqual([
      { kind: 'ordered', items: [{ n: 1, text: 'первое' }, { n: 2, text: 'второе' }] },
    ]);
  });

  it('строки «Заголовок: …» становятся списком, предложение с двоеточием — нет', () => {
    expect(chatBlocks('Однодневные: сплав по Быстрой.\nВертолётные: Курильское озеро.\nМногодневные: Налычево.')).toEqual([
      { kind: 'list', items: ['Однодневные: сплав по Быстрой.', 'Вертолётные: Курильское озеро.', 'Многодневные: Налычево.'] },
    ]);
    expect(chatBlocks('Однодневные: сплав. Вертолётные: озеро. Многодневные: поход.')).toEqual([
      { kind: 'list', items: ['Однодневные: сплав.', 'Вертолётные: озеро.', 'Многодневные: поход.'] },
    ]);
    expect(chatBlocks('Коротко так. Однодневные: сплав. Вертолётные: озеро.')).toEqual([
      { kind: 'text', text: 'Коротко так.' },
      { kind: 'list', items: ['Однодневные: сплав.', 'Вертолётные: озеро.'] },
    ]);
    expect(chatBlocks('- Однодневные: сплав\n- Вертолётные: озеро')).toEqual([
      { kind: 'list', items: ['Однодневные: сплав', 'Вертолётные: озеро'] },
    ]);
    expect(chatBlocks('В июле на Камчатке пик сезона: все маршруты открыты.')).toEqual([
      { kind: 'text', text: 'В июле на Камчатке пик сезона: все маршруты открыты.' },
    ]);
    expect(chatBlocks('Встреча в 10:30 у порта.')).toEqual([
      { kind: 'text', text: 'Встреча в 10:30 у порта.' },
    ]);
  });

  it('оба чата рисуют ответ через ChatText, сообщение человека — текстом', () => {
    for (const f of ['app/kuzmich/_KuzmichClient.tsx', 'components/kuzmich/KuzmichWidget.tsx']) {
      expect(readFileSync(f, 'utf8')).toContain("msg.role === 'assistant' ? <ChatText text={msg.content} /> : msg.content");
    }
  });
});
