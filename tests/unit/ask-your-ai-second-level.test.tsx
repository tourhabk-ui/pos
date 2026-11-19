// @vitest-environment jsdom
/**
 * #3468: «Спросить у другого ИИ» на карточке тура — второй уровень, вопрос о
 * самой странице. Главная дорога — Кузьмич (кнопка рядом).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import AskYourAi from '@/components/kuzmich/AskYourAi';

afterEach(cleanup);

const url = 'https://vedarai.ru/catalog/tours/lagexp-kamchatka-na-maksimum-zimnij-marshrut';

describe('AskYourAi: внешние ИИ вторым уровнем', () => {
  it('свёрнут: ссылки внутри закрытого details', () => {
    const { container } = render(<AskYourAi question="Что входит в тур?" pageUrl={url} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(screen.getByText('Спросить у другого ИИ').tagName).toBe('SUMMARY');
    const links = details!.querySelectorAll('a[data-ai-ask]');
    expect(links.length).toBe(3);
  });
  it('ссылки спрашивают о странице Ведара, а не «стоит ли ехать»', () => {
    const { container } = render(<AskYourAi question="Что входит в тур?" pageUrl={url} />);
    for (const a of Array.from(container.querySelectorAll('a[data-ai-ask]'))) {
      const href = decodeURIComponent(a.getAttribute('href') || '');
      expect(href).toContain(url);
      expect(href).toContain('Не ищи на других сайтах');
      expect(href).not.toContain('Стоит ли');
    }
  });
  it('человеку сказано, что чужой ИИ отвечает не по каталогу и цены — у оператора', () => {
    render(<AskYourAi question="Что входит в тур?" pageUrl={url} />);
    expect(screen.getByText(/может уйти на другие сайты/)).toBeTruthy();
    expect(screen.getByText(/называет только\s+оператор/)).toBeTruthy();
  });
});
