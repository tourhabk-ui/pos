/**
 * Экран «SOS и безопасность» называет настоящий источник и настоящее время.
 *
 * Скриншот владельца 05.09: вкладка «Вулканы» — «обновлено в 14:39», а
 * записи от 31 августа; вкладка «Сейсмика» — «Источник: USGS · 14:40» при
 * одном событии из ленты КБГС и подписи «Глубина: 0 км» там, где глубины
 * нет вовсе. Отсюда ощущение «перестал обновлять данные»: часы шли, данные
 * стояли, и отличить тихий край от молчащего конвейера было нечем.
 *
 * Три подмены разом, все из §4.0:
 *   · время НАЖАТИЯ выдавалось за время ПРОВЕРКИ источника;
 *   · имя источника стояло в вёрстке, а не приходило из ответа: КБГС РАН
 *     подписывался как USGS, лента МЧС и КВЕРТ — как КБГС РАН;
 *   · Math.round(null) печатал уверенный ноль вместо «глубина неизвестна».
 *
 * Судим код, а не прозу: комментарии из исходников вырезаны.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const HUB = strip(read('app/hub/safety/_SafetyHubClient.tsx'));
const VOLCANIC = strip(read('app/api/safety/volcanic/route.ts'));

describe('источник называется по ответу, а не по вёрстке', () => {
  it('в вёрстке не осталось прибитых подписей источника', () => {
    expect(HUB).not.toMatch(/Источник: USGS/);
    expect(HUB).not.toMatch(/Источник: КБГС РАН/);
    expect(HUB).not.toMatch(/Загрузка данных (USGS|КБГС РАН)/);
  });

  it('сейсмика подписывается родом ленты из ответа роута', () => {
    expect(HUB).toMatch(/SEISMIC_SOURCE_LABEL\[seismicSource\]/);
    expect(HUB).toMatch(/kbgsras: 'КБГС РАН'/);
    expect(HUB).toMatch(/usgs: 'USGS'/);
    expect(HUB).toMatch(/setSeismicSource\(d\.source \?\? ''\)/);
  });

  it('неизвестный род не подписывается чужим именем', () => {
    expect(HUB).toMatch(/\?\? 'Источник не назвался'/);
  });

  it('вулканы не подписаны КБГС РАН — она про сейсмику', () => {
    expect(HUB).toMatch(/Лента МЧС и КВЕРТ/);
  });
});

describe('время — момент проверки источника, а не момент нажатия', () => {
  it('состояний «last update по new Date()» больше нет', () => {
    expect(HUB).not.toMatch(/setSeismicLastUpdate|setVolcanicLastUpdate/);
    expect(HUB).not.toMatch(/LastUpdate\(new Date\(\)\)/);
  });

  it('обе ленты читают время проверки из ответа', () => {
    expect(HUB).toMatch(/setSeismicCheckedAt\(d\.checkedAt \?\? null\)/);
    expect(HUB).toMatch(/setVolcanicCheckedAt\(d\.checked_at \?\? null\)/);
  });

  it('нет времени — так и написано, а не свежие часы', () => {
    expect(HUB).toMatch(/function checkedLabel/);
    expect(HUB).toMatch(/return 'проверить не удалось'/);
  });
});

describe('кнопка «Обновить» спрашивает источник', () => {
  it('сейсмика и погода уходят с fresh=1', () => {
    expect(HUB).toMatch(/\/api\/safety\/seismic\?fresh=1/);
    expect(HUB).toMatch(/\/api\/safety\/weather\?fresh=1/);
  });
});

describe('глубина: неизвестна — значит неизвестна', () => {
  it('тип допускает отсутствие', () => {
    expect(HUB).toMatch(/depth: number \| null/);
  });

  it('строка глубины рисуется только при значении', () => {
    expect(HUB).toMatch(/ev\.depth != null \? `Глубина: \$\{Math\.round\(ev\.depth\)\} км · ` : ''/);
  });
});

describe('роут вулканов сообщает, когда лента проверялась', () => {
  it('время берётся из журнала прогонов приёма', () => {
    expect(VOLCANIC).toMatch(/MAX\(ended_at\)[\s\S]{0,120}agent_id = 'safety-ingest'/);
    expect(VOLCANIC).toMatch(/checked_at: await lastIngestAt\(\)/);
  });

  it('прогонов нет или запрос упал — null и строка в логе, не выдуманное «сейчас»', () => {
    expect(VOLCANIC).toMatch(/return at \? new Date\(at\)\.toISOString\(\) : null/);
    expect(VOLCANIC).toMatch(/console\.error\('\[safety\/volcanic\] last ingest run:'/);
    expect(VOLCANIC).toMatch(/checked_at: null, error: msg/);
  });
});
