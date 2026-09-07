/**
 * Сторож отметки обновления на экране безопасности (07.09).
 *
 * Владелец прислал снимок: сильнейший толчок «5 ч назад», а под ним строка
 * «Источник: КВЕРТ · Камчатское УГМС · КБГС РАН / USGS · обновлено 9 ч назад».
 * Данные не могут быть новее собственной отметки обновления — значит отметка
 * говорила не о тех источниках, которые называла.
 *
 * Так и было: цифра бралась из `location_real_time_status` — таблицы о
 * загруженности и режиме работы МЕСТ. К КВЕРТ, КБГС РАН и USGS она отношения
 * не имеет. Одна отметка на четыре источника — это по построению неправда о
 * трёх из них.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const CLIENT = strip(readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf8'));
const DATA = strip(readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf8'));

describe('каждая отметка — от своего источника', () => {
  it('строка источников больше не берёт время из состояния мест', () => {
    expect(CLIENT).not.toMatch(/live\.safety\.updatedAt/);
  });

  it('у вулканов — своя отметка, у сейсмики — своя', () => {
    expect(CLIENT).toMatch(/stampLabel\(live\.volcanoes\.updatedAt\)/);
    expect(CLIENT).toMatch(/stampLabel\(live\.seismic\.checkedAt\)/);
  });

  it('сейсмика показывает время ОПРОСА, а не сборки ответа', () => {
    // `updatedAt` в ленте — это `new Date()` в момент ответа: он всегда
    // «только что» и обещает свежесть, которой никто не проверял.
    expect(CLIENT).not.toMatch(/live\.seismic\.updatedAt/);
  });

  it('отсутствие отметки называется словами, а не пустым местом', () => {
    expect(CLIENT).toMatch(/время обновления неизвестно/);
  });
});

describe('время опроса доходит до экрана', () => {
  it('снимок сейсмики несёт checkedAt', () => {
    expect(DATA).toMatch(/checkedAt: string \| null/);
    expect(DATA).toMatch(/feedResult\.checkedAt/);
  });

  it('откат при отказе ленты не выдумывает время опроса', () => {
    const fallback = DATA.slice(DATA.indexOf('getSeismicFeed().catch'));
    expect(fallback.slice(0, 200)).toMatch(/checkedAt: null/);
  });
});
