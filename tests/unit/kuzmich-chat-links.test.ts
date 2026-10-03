import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chatLinkChunks } from '@/lib/kuzmich/chat-links';

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

  it('не http(s) ссылкой не становится; текст без ссылок — один кусок', () => {
    expect(chatLinkChunks('javascript:alert(1)').every(c => !c.href)).toBe(true);
    expect(chatLinkChunks('просто текст')).toEqual([{ text: 'просто текст' }]);
  });

  it('оба чата рисуют ответ через ChatText, сообщение человека — текстом', () => {
    for (const f of ['app/kuzmich/_KuzmichClient.tsx', 'components/kuzmich/KuzmichWidget.tsx']) {
      expect(readFileSync(f, 'utf8')).toContain("msg.role === 'assistant' ? <ChatText text={msg.content} /> : msg.content");
    }
  });
});
