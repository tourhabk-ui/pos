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
import { normalizeVolcanoName } from '@/lib/services/safety/kvert-vona';
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

describe('«когда спрашивали» — одно правило на все ленты', () => {
  // Замер 05.09 (prod-check run 15): приём отработал минуту назад, а
  // свежайшая запись землетрясения — 41-часовой давности. Возраст ЗАПИСИ и
  // возраст ПРОГОНА — разные вопросы; на экране нужен второй, иначе живой
  // приём читается как поломка.
  const RULE = strip(read('lib/safety/ingest-run.ts'));
  const FEED = strip(read('lib/services/safety/seismic-feed.ts'));

  it('правило одно и живёт в общем модуле', () => {
    expect(RULE).toMatch(/MAX\(ended_at\)[\s\S]{0,140}agent_id = \$1 AND status = 'success'/);
    expect(RULE).toMatch(/INGEST_AGENT_ID = 'safety-ingest'/);
  });

  it('обе ленты зовут его, а не считают по-своему', () => {
    expect(VOLCANIC).toMatch(/lastIngestAt\(\)/);
    expect(FEED).toMatch(/const runAt = await lastIngestAt\(\)/);
    expect(FEED).not.toMatch(/MAX\(created_at\) AS at FROM external_alerts/);
  });

  it('прогонов нет или запрос упал — null и строка в логе, не выдуманное «сейчас»', () => {
    expect(RULE).toMatch(/return at \? new Date\(at\)\.toISOString\(\) : null/);
    expect(RULE).toMatch(/console\.error\('\[safety\] последний прогон приёма не установлен:'/);
    expect(VOLCANIC).toMatch(/checked_at: null, statuses:/);
  });
});

describe('вкладка «Вулканы» показывает и текущие коды KVERT (владелец 06.09)', () => {
  // Замер prod-check run 15: за семь суток одна новость шестидневной
  // давности, а коды KVERT обновлялись каждые 6 часов и жили только на
  // главной. Новость говорит «что случилось», код — «что сейчас».
  const STATUS = strip(read('lib/services/safety/volcano-status.ts'));

  it('коды приходят тем же роутом, что и новости', () => {
    expect(VOLCANIC).toMatch(/getVolcanoStatuses/);
    expect(VOLCANIC).toMatch(/statuses/);
  });

  it('отказ новостей не гасит коды и наоборот', () => {
    expect(VOLCANIC).toMatch(/events: \[\], checked_at: null, statuses: await getVolcanoStatuses\(\)/);
    expect(HUB).toMatch(/setVolcanoStatuses\(d\.statuses \?\? null\)/);
  });

  it('реестр не прочитан — сказано прямо, а не «везде спокойно»', () => {
    expect(STATUS).toMatch(/total: null, green: null, updated_at: null/);
    expect(STATUS).toMatch(/console\.error\('\[safety\] коды KVERT не прочитаны:'/);
    expect(HUB).toMatch(/Коды KVERT прочитать не удалось/);
  });

  it('подписи цветов берутся из общего словаря, а не заводятся заново', () => {
    expect(HUB).toMatch(/ACC_META\[\(v\.color as AccColor\)\]/);
    expect(HUB).not.toMatch(/'Оранжевый'|'Жёлтый'|'Красный'/);
  });

  it('старое наблюдение помечено, дата наблюдения не выдумывается', () => {
    expect(HUB).toMatch(/isVolcanoObservationStale\(v\.observed_at\)/);
    expect(HUB).toMatch(/'дата неизвестна'/);
  });

  it('время проверки за пределами сегодняшнего дня называет день', () => {
    expect(HUB).toMatch(/t\.toDateString\(\) === now\.toDateString\(\)/);
  });
});

describe('вулкан назван по-русски, но не переименован наугад', () => {
  // Замер prod-check run 18: KVERT отдал KLYUCHEVSKOY, SHEVELUCH, BEZYMIANNY,
  // KRASHENINNIKOV — капсом и латиницей. На русском экране безопасности это
  // читается как код, а не как вулкан.
  it('имена с прода переводятся общей таблицей алиасов', () => {
    expect(normalizeVolcanoName('KLYUCHEVSKOY')?.ru).toBe('Ключевской');
    expect(normalizeVolcanoName('SHEVELUCH')?.ru).toBe('Шивелуч');
    expect(normalizeVolcanoName('BEZYMIANNY')?.ru).toBe('Безымянный');
  });

  it('незнакомый вулкан остаётся под своим именем, а не «похожим»', () => {
    const STATUS = strip(read('lib/services/safety/volcano-status.ts'));
    expect(STATUS).toMatch(/normalizeVolcanoName\(r\.volcano_name\)\?\.ru \?\? r\.volcano_name/);
    expect(normalizeVolcanoName('SOMETHING-UNKNOWN')).toBeNull();
  });
});
