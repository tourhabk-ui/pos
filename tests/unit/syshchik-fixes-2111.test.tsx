/**
 * Правки Сыщика 21.11, сверенные по первоисточникам: закрытый Мутновский,
 * постановление № 1323 на /prepare, медведи Курильского озера по формулировке
 * Кроноцкого заповедника, оговорка о сезоне тура на дне плана.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { routeClosure, landingClosure, MUTNOVSKY_CLOSURE } from '@/lib/routes/closures';
import { ClosureNotice } from '@/components/routes/ClosureNotice';
import { landingByKey } from '@/lib/seo/query-landings';
import { VOLCANOES_DECREE_DOC } from '@/lib/safety/park-permit';
import { tourSeasonNote } from '@/lib/plans/preset-plan';

const root = process.cwd();
const SQL = readFileSync(join(root, 'migrations/1485_syshchik_fixes_mutnovsky_kurile.sql'), 'utf-8');

describe('правки Сыщика 21.11', () => {
  it('Мутновский: плашка на маршруте и на посадочной туров, с источниками и датой', () => {
    expect(routeClosure('vulkan-mutnovskiy-874283be')).toBe(MUTNOVSKY_CLOSURE);
    expect(landingClosure('ru-mutnovsky')).toBe(MUTNOVSKY_CLOSURE);
    expect(routeClosure('vulkan-gorelyj')).toBeNull();
    expect(MUTNOVSKY_CLOSURE.text).toMatch(/2022/);
    expect(MUTNOVSKY_CLOSURE.text).toMatch(/11\.08\.2026/);
    const html = renderToStaticMarkup(<ClosureNotice closure={MUTNOVSKY_CLOSURE} />);
    expect(html).toContain('Маршрут на Мутновский закрыт');
    expect(html).toContain('vulcanikamchatki.ru');
  });

  it('посадочная Мутновского: без «джип-туров к подножию», вопрос о закрытии и № 1323', () => {
    const l = landingByKey('ru-mutnovsky');
    const text = JSON.stringify(l);
    expect(text).not.toMatch(/джип/i);
    expect(text).toMatch(/№ 1323/);
    expect(l.faq.some((f) => 'q' in f && /сейчас подняться/.test(f.q))).toBe(true);
  });

  it('миграция 1485: снимает «самый доступный» и «самую большую популяцию в мире»', () => {
    expect(SQL).toContain("'Самый доступный маршрут «заглянуть внутрь действующего вулкана» Камчатки. ', ''");
    expect(SQL).toContain('самая большая охраняемая популяция бурого медведя на Камчатке');
    expect(SQL).toMatch(/IS DISTINCT FROM pg_temp\.mutnovsky_fix/);
  });

  it('/prepare называет постановление № 1323 со ссылкой на government.ru', () => {
    expect(VOLCANOES_DECREE_DOC.title).toMatch(/9 октября 2026 г\. № 1323/);
    expect(VOLCANOES_DECREE_DOC.url).toBe('http://government.ru/docs/all/166655/');
    expect(readFileSync(join(root, 'app/prepare/page.tsx'), 'utf-8')).toContain('data-federal-parks');
  });

  it('оговорка о сезоне тура на дне плана', () => {
    expect(tourSeasonNote('2027-07-01', '2027-09-30')).toBe('Тур идёт только с 1 июля по 30 сентября: в другие даты этого дня в плане не будет.');
    expect(tourSeasonNote(null, '2027-09-30')).toBeNull();
    expect(tourSeasonNote('2027-01-01', '2027-12-31')).toBeNull();
  });
});
