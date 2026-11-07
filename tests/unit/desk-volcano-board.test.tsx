// @vitest-environment jsdom
/**
 * Табло вулканов на главной: цвет КФ ЕГС назван своей шкалой, а не «сейсмикой» (#3138).
 *
 * Цвет КФ ЕГС складывается из сейсмичности, газа, термоаномалий и пепла
 * (легенда сводки, `lib/services/safety/emsd-vmon.ts`). Столбец «Сейсмика»
 * приписывал жёлтый Шивелуча сейсмичности, которая по той же сводке фоновая.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { DeskVolcanoBoard } from '@/components/homepage/desk/DeskVolcanoBoard';

afterEach(cleanup);

describe('табло вулканов', () => {
  it('столбцы — «Пепел» и «КФ ЕГС», «Сейсмики» нет', () => {
    render(
      <DeskVolcanoBoard
        volcanoes={{
          sources: 'Источники — …', complete: true, more: 0,
          items: [{ name: 'Шивелуч', ash: 'оранжевый', ashKm: 12, tremor: 'жёлтый', level: 'orange', ashCode: 'orange', tremorCode: 'yellow' }],
        }}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Вулкан', 'Пепел', 'КФ ЕГС']);
    expect(screen.queryByText('Сейсмика')).toBeNull();
    expect(screen.getByText('Шивелуч')).toBeTruthy();
  });
});
