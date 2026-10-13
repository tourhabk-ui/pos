/**
 * Вулкан в аргументе инструмента — тот, о котором говорит человек (пробы 764
 * и 765, 13.10).
 *
 * На вопрос про Авачинский Кузьмич дважды ответил про чужой вулкан — про
 * Ключевской и про Мутновский, ровно про два примера из описания параметра
 * get_volcano_status. Запасная модель (пик DeepSeek) копировала пример в
 * вызов, инструмент честно отдавал данные по чужому вулкану.
 *
 * Сторож держит обе половины починки: примеров-названий в описаниях
 * параметров нет; аргумент с вулканом не из разговора заменяется названным
 * (или вызов не исполняется, если названо несколько); цикл инструментов
 * исполняет вызовы через сторожа, а разговор берётся без системного промпта.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardPlaceArgs, PLACE_ARGS } from '@/lib/kuzmich/place-arg-guard';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import { KNOWN_VOLCANO_NAMES_RU } from '@/lib/services/safety/kvert-vona';

const PROBE = 'Служебная проверка журнала общения Ведара: какая сейчас обстановка у Авачинского вулкана? Ответь в двух предложениях.';

describe('аргумент с чужим вулканом', () => {
  it('пробы 764 и 765: пример из описания заменяется названным вулканом', () => {
    expect(guardPlaceArgs('get_volcano_status', { volcano: 'Ключевской' }, PROBE))
      .toEqual({ kind: 'rebind', args: { volcano: 'Авачинский' }, from: 'Ключевской', to: 'Авачинский' });
    expect(guardPlaceArgs('get_volcano_status', { volcano: 'Мутновский' }, PROBE))
      .toMatchObject({ kind: 'rebind', args: { volcano: 'Авачинский' } });
  });

  it('то же для погоды и контекста места; прочие аргументы не теряются', () => {
    expect(guardPlaceArgs('get_weather', { place: 'Мутновский', days: '2' }, PROBE))
      .toMatchObject({ kind: 'rebind', args: { place: 'Авачинский', days: '2' } });
    expect(guardPlaceArgs('get_guardian_context', { place: 'вулкан Ключевской' }, PROBE))
      .toMatchObject({ kind: 'rebind', args: { place: 'Авачинский' } });
    expect(guardPlaceArgs('get_place_info', { name: 'Горелый' }, PROBE))
      .toMatchObject({ kind: 'rebind', args: { name: 'Авачинский' } });
  });

  it('вулкан из разговора — не трогаем, в любом падеже и форме', () => {
    expect(guardPlaceArgs('get_volcano_status', { volcano: 'Авачинский' }, PROBE)).toEqual({ kind: 'keep' });
    expect(guardPlaceArgs('get_guardian_context', { place: 'Авачинский вулкан' }, PROBE)).toEqual({ kind: 'keep' });
    expect(guardPlaceArgs('get_volcano_status', { volcano: 'Ключевская сопка' }, 'что на Ключевском?')).toEqual({ kind: 'keep' });
  });

  it('в разговоре вулкан не назван — модель вправе вывести его сама', () => {
    expect(guardPlaceArgs('get_volcano_status', { volcano: 'Авачинский' }, 'какой вулкан рядом с Петропавловском?')).toEqual({ kind: 'keep' });
  });

  it('названо несколько, в аргументе другой — не угадываем, просим вызвать по каждому', () => {
    const d = guardPlaceArgs('get_volcano_status', { volcano: 'Ключевской' }, 'сравни Мутновский и Горелый');
    expect(d.kind).toBe('ask');
    if (d.kind === 'ask') {
      expect(d.message).toMatch(/«Мутновский»/);
      expect(d.message).toMatch(/«Горелый»/);
    }
  });

  it('не вулкан и не инструмент места — не трогаем', () => {
    expect(guardPlaceArgs('get_weather', { place: 'Налычево' }, PROBE)).toEqual({ kind: 'keep' });
    expect(guardPlaceArgs('get_tours', { activity_type: 'Ключевской' }, PROBE)).toEqual({ kind: 'keep' });
    expect(guardPlaceArgs('get_volcano_status', {}, PROBE)).toEqual({ kind: 'keep' });
  });
});

describe('описания параметров не подсказывают названий', () => {
  const params = Object.values(KUZMICH_TOOLS).flatMap((t) => {
    const props = (t.function.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
    return Object.entries(props).map(([key, p]) => ({ tool: t.function.name, key, text: p.description ?? '' }));
  });

  it('ни одного названия вулкана в описаниях параметров Кузьмича', () => {
    expect(params.length).toBeGreaterThan(10);
    for (const p of params) {
      for (const v of KNOWN_VOLCANO_NAMES_RU) {
        expect(p.text, `${p.tool}.${p.key} называет «${v}»`).not.toContain(v);
      }
    }
  });

  it('у параметров мест — ни примеров в кавычках, ни координат-образцов', () => {
    for (const [tool, keys] of Object.entries(PLACE_ARGS)) {
      for (const key of keys) {
        const p = params.find((x) => x.tool === tool && x.key === key);
        expect(p, `${tool}.${key} нет в KUZMICH_TOOLS`).toBeDefined();
        expect(p!.text, `${tool}.${key}`).not.toMatch(/«|например/);
      }
    }
    const lat = params.find((x) => x.tool === 'get_weather' && x.key === 'lat');
    const lng = params.find((x) => x.tool === 'get_weather' && x.key === 'lng');
    expect(lat!.text).not.toMatch(/\d/);
    expect(lng!.text).not.toMatch(/\d/);
  });
});

describe('цикл инструментов исполняет вызовы через сторожа', () => {
  it('runTurnTools получает execGuarded; разговор — вопрос и история, без системного промпта', () => {
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');
    expect(core).toMatch(/runTurnTools\(result\.tool_calls, seenToolSigs, execGuarded, validateToolArgs\)/);
    expect(core).not.toMatch(/runTurnTools\(result\.tool_calls, seenToolSigs, executeTool,/);
    const at = core.indexOf('const conversation = [userText');
    expect(at, 'разговор для сторожа не собран').toBeGreaterThan(0);
    expect(core.slice(at, core.indexOf('\n', at))).not.toMatch(/systemContent/);
  });
});
