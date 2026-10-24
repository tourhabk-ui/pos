/**
 * Программа на несколько дней (аудит 24.10): сезон решается до списка дней,
 * дни — строками «День N —», а «что посмотреть» тянет карточки каталога.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import ChatText from '@/components/kuzmich/ChatText';
import { KUZMICH_SYSTEM } from '@/lib/kuzmich/core';

describe('дни программы — подзаголовки', () => {
  it('«День 1 —» жирнее обычной строки, ссылка внутри остаётся ссылкой', () => {
    render(
      <ChatText text={'Сейчас межсезонье.\nДень 1 — берег\nСсылка: https://vedarai.ru/catalog'} />,
    );
    const day = screen.getByText('День 1 — берег');
    expect(day.closest('.font-semibold')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'https://vedarai.ru/catalog' });
    expect(link.getAttribute('href')).toBe('/catalog');
  });
});

describe('промпт решает сезон до дней', () => {
  it('календарь и запрет «расписал, потом отменил» стоят в системном тексте', () => {
    expect(KUZMICH_SYSTEM).toContain('СЕГОДНЯ');
    expect(KUZMICH_SYSTEM).toContain('День 1 —');
    expect(KUZMICH_SYSTEM).toMatch(/уже не сезон/);
  });
});
