/**
 * Шапка пульса не выдумывает лидера, когда данных для выбора нет.
 *
 * ── Случай 03.09 ───────────────────────────────────────────────────────────
 *
 * Владелец заметил: в шапке пульса вулканов всегда стоит Шивелуч. Причина
 * была не в активности — сводный формат KVERT (`parseAccSummary`) не даёт
 * высоту пепла, и у двух оранжевых вулканов `ashHeightM` были оба `null`.
 * Прежний тай-брейк сортировки — `a.name.localeCompare(b.name, 'ru')` —
 * решал ничью АЛФАВИТОМ: «Шивелуч» стоит после «Ключевской сопки», и
 * `bars[bars.length - 1]` каждый раз выбирал его. Придуманный ранг там, где
 * ранжировать нечем, — тот самый случай §4.0: обязана быть третья
 * возможность сказать «не могу выбрать».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LIVE = strip(read('components/safety/LiveStatus.tsx'));
const at = LIVE.indexOf('export function VolcanoPulse');
const comp = LIVE.slice(at, at + 4500);

describe('сортировка столбиков не решает ничью алфавитом', () => {
  it('в сортировке нет localeCompare по имени', () => {
    const sortAt = comp.indexOf('const bars = [...items].sort');
    const sortBlock = comp.slice(sortAt, sortAt + 300);
    expect(sortBlock, 'алфавитный тай-брейк вернулся').not.toMatch(/localeCompare/);
  });

  it('отсутствие пепла не считается нулевой высотой (null !== 0)', () => {
    // (a.ashHeightM ?? 0) уравнивало «пепла нет» с «пепел нулевой» —
    // разные вещи, а -1 держит null снизу без ложного нуля.
    const sortAt = comp.indexOf('const bars = [...items].sort');
    const sortBlock = comp.slice(sortAt, sortAt + 300);
    expect(sortBlock).toMatch(/ashHeightM \?\? -1/);
  });
});

describe('ничья на вершине объявляется, а не разрешается угадыванием', () => {
  it('код держит явную переменную ничьей', () => {
    expect(comp).toMatch(/const topTied = topTier\.length > 1/);
  });

  it('при ничье шапка говорит «N вулканов», а не называет одного', () => {
    const at2 = comp.indexOf('topTied ?');
    const block = comp.slice(at2, at2 + 500);
    expect(block).toMatch(/topTier\.length/);
    expect(block).toMatch(/выделить одного нечем/);
  });

  it('без ничьи шапка по-прежнему называет вулкан поимённо', () => {
    const at2 = comp.indexOf('topTied ?');
    const block = comp.slice(at2, at2 + 700);
    expect(block).toMatch(/top\.name\.replace/);
  });
});

describe('живой случай: два оранжевых без пепла', () => {
  // Тот же расчёт, что делает компонент — без импорта React, чистой логикой.
  const ACC_ORDER: Record<string, number> = { green: 0, yellow: 1, orange: 2, red: 3 };
  interface V { name: string; acc: string; ashHeightM: number | null }
  const items: V[] = [
    { name: 'Вулкан Ключевская сопка', acc: 'orange', ashHeightM: null },
    { name: 'Шивелуч', acc: 'orange', ashHeightM: null },
    { name: 'Безымянный', acc: 'yellow', ashHeightM: null },
  ];

  function pickTop(list: V[]) {
    const bars = [...list].sort((a, b) =>
      (ACC_ORDER[a.acc] ?? 0) - (ACC_ORDER[b.acc] ?? 0)
      || (a.ashHeightM ?? -1) - (b.ashHeightM ?? -1));
    const topOrder = ACC_ORDER[bars[bars.length - 1].acc] ?? 0;
    const topAsh = bars[bars.length - 1].ashHeightM ?? -1;
    return bars.filter((v) => (ACC_ORDER[v.acc] ?? 0) === topOrder && (v.ashHeightM ?? -1) === topAsh);
  }

  it('оба оранжевых входят в вершину — ничья, не единственный «Шивелуч»', () => {
    const top = pickTop(items);
    expect(top).toHaveLength(2);
    expect(top.map((v) => v.name).sort()).toEqual(['Вулкан Ключевская сопка', 'Шивелуч']);
  });

  it('появление высоты пепла у одного из них разрешает ничью честно', () => {
    const withAsh = items.map((v) => v.name === 'Шивелуч' ? { ...v, ashHeightM: 3000 } : v);
    const top = pickTop(withAsh);
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe('Шивелуч');
  });
});
