/**
 * Тест планировщика владельца 21.11: списки в ответе Кузьмича слипались в
 * абзац с «-» (390 px) и пункт прилипал к строке (десктоп), поле ввода на
 * телефоне уезжало вместе с ответом, туры в тексте — не ссылки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatBlocks, chatLinkChunks, expandInlineItems } from '@/lib/kuzmich/chat-links';
import { prepareSpeechText } from '@/lib/ai/speech-text';

describe('списки в ответе', () => {
  it('слипшиеся пункты «…полнее. - Восхождение…» — два пункта', () => {
    const text = 'Два момента:\n- День 6 пустой — можно добавить занятие, и план соберётся полнее. - Восхождение на Горелый — активная зона, нужен гид.';
    expect(chatBlocks(text)).toEqual([
      { kind: 'text', text: 'Два момента:' },
      { kind: 'list', items: [
        'День 6 пустой — можно добавить занятие, и план соберётся полнее.',
        'Восхождение на Горелый — активная зона, нужен гид.',
      ] },
    ]);
  });

  it('с живого ответа 21.11: три пункта в одной строке', () => {
    const line = '- Летняя рыбалка на кижуча — 1 день (Камчатская рыбалка). - Осенняя рыбалка (октябрь–ноябрь) — 1 день. - Недельный тур (7 дней).';
    const blocks = chatBlocks(line);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'list' });
    expect((blocks[0] as { items: string[] }).items).toHaveLength(3);
  });

  it('тире внутри фразы, дефис в слове и диапазон дат не режут строку', () => {
    const t = 'Горелый — 15 000 ₽, сезон июль–сентябрь, северо-восток.';
    expect(expandInlineItems(t)).toBe(t);
    expect(chatBlocks(t)).toEqual([{ kind: 'text', text: t }]);
  });

  it('строка без маркера: начало — текст, слипшиеся пункты — список', () => {
    expect(chatBlocks('Важно учесть. - Берите дождевик. - Гид обязателен.')).toEqual([
      { kind: 'text', text: 'Важно учесть.' },
      { kind: 'list', items: ['Берите дождевик.', 'Гид обязателен.'] },
    ]);
  });
});

describe('туры ссылками', () => {
  it('«[название](/catalog/tours/slug)» — внутренняя ссылка с названием', () => {
    const c = chatLinkChunks('День 2. [Восхождение на Горелый](/catalog/tours/gorelyj) — 15 000 ₽');
    expect(c).toEqual([
      { text: 'День 2. ' },
      { text: 'Восхождение на Горелый', href: '/catalog/tours/gorelyj' },
      { text: ' — 15 000 ₽' },
    ]);
  });

  it('свой домен в markdown — путём; чужая схема — текстом', () => {
    expect(chatLinkChunks('[тур](https://vedarai.ru/catalog/tours/x)')[0]).toEqual({ text: 'тур', href: '/catalog/tours/x' });
    expect(chatLinkChunks('[жми](javascript:alert(1))').every((c) => !c.href)).toBe(true);
  });

  it('вслух — только название тура, без адреса', () => {
    expect(prepareSpeechText('Тур [Горелый](/catalog/tours/gorelyj) хорош').text).toBe('Тур Горелый хорош');
  });
});

describe('поле ввода на телефоне', () => {
  const src = readFileSync(join(process.cwd(), 'app/kuzmich/_KuzmichClient.tsx'), 'utf-8');
  it('прилипает к низу экрана, карточка не обрезает sticky', () => {
    expect(src).toMatch(/data-kuzmich-input className="sticky bottom-0/);
    expect(src).toContain('safe-area-inset-bottom');
    expect(src).not.toMatch(/rounded-xl overflow-hidden \$\{hasMessages/);
  });
  it('шрифт поля 16 px на телефоне — iOS не увеличивает страницу при фокусе', () => {
    expect(src).toMatch(/text-base sm:text-sm outline-none/);
  });
});
