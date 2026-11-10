// @vitest-environment node
/**
 * Перепись «точек помощи» по OpenStreetMap (10.11, #2930).
 *
 * Владелец на вопрос «делать ли ближайшие точки в SOS?» ответил «да». Своего
 * списка приютов, кордонов и медпунктов у платформы нет; перепись считает,
 * что знает открытая карта. По её числам будет выбран источник для экрана,
 * который читает человек в беде, поэтому врать она не должна ни в одну сторону.
 *
 * Сторож судит поведение:
 *  - род точки по тегам; остановка транспорта укрытием не считается;
 *  - один объект карты считается один раз (линия и площадь здания, точка и
 *    контур села);
 *  - ноль точек, битая строка, нет файла — красный исход, а не «пусто»;
 *  - отчёт называет область и то, чего карта не знает; слова «безопасный» в
 *    нём нет;
 *  - фильтр выгрузки в workflow пропускает каждый тег, который читает скрипт;
 *  - шаги workflow исполняются настоящим bash -e с подложенными командами:
 *    нет границы края — рамка, и отчёт говорит об этом; сводка пишется и при
 *    красном исходе;
 *  - граница — ОДИН контур края. Первая редакция отдала вырезке все контуры
 *    файла, вложенные сосчитались по чёт-нечет, и из края молча выпали
 *    Петропавловск и полсотни сёл. Отсюда контрольные населённые пункты: нет
 *    хоть одного — перепись красная.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  BANDS, CITY, CONTROL_SETTLEMENTS, KINDS, LIST_LIMIT, READ_TAGS, REGION_ISO,
  addFeature, canonicalId, centerOf, classify, distanceKm, emptyCensus, formatReport, main, missingControl,
  pickBoundary, readCensus,
} from '../../scripts/help-points-osm-census.mjs';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/help-points-osm-census.mjs');
const WORKFLOW = join(ROOT, '.github/workflows/help-points-osm-census.yml');
const MARKER = join(ROOT, '.github/triggers/help-points-osm-census.json');

type Tags = Record<string, string>;
const point = (id: string, tags: Tags, lng = 158.0, lat = 54.0) =>
  ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lng, lat] }, properties: tags });
const seq = (features: unknown[]) => features.map((f) => `\x1e${JSON.stringify(f)}`);
/** Контрольные населённые пункты точками в городе — чтобы вырезка считалась полной. */
const control = () => (CONTROL_SETTLEMENTS as readonly string[])
  .map((name, i) => point(`n${9000 + i}`, { place: 'village', name }, 158.65, 53.02));
const polygon = (tags: Tags, type: 'Polygon' | 'MultiPolygon' = 'MultiPolygon') => ({
  type: 'Feature',
  geometry: type === 'Polygon'
    ? { type, coordinates: [[[156, 51], [162, 51], [162, 60], [156, 51]]] }
    : { type, coordinates: [[[[156, 51], [162, 51], [162, 60], [156, 51]]]] },
  properties: tags,
});

describe('род точки по тегам', () => {
  it('каждый тег из списка читаемых даёт свой род', () => {
    expect(READ_TAGS.length).toBeGreaterThan(20);
    for (const t of READ_TAGS) {
      expect(classify({ [t.key]: t.value }, 'n1'), `${t.key}=${t.value}`).toBe(t.kind);
    }
  });

  it('у каждого рода из списка вывода есть хотя бы один читаемый тег', () => {
    const produced = new Set(READ_TAGS.map((t: { kind: string }) => t.kind));
    for (const k of KINDS) expect(produced.has(k.key), k.key).toBe(true);
  });

  it('остановка транспорта — не укрытие', () => {
    expect(classify({ amenity: 'shelter', shelter_type: 'public_transport' }, 'n1')).toBe('transit');
    expect(classify({ amenity: 'shelter', shelter_type: 'basic_hut' }, 'n1')).toBe('shelter');
    expect(classify({ amenity: 'shelter' }, 'n1')).toBe('shelter');
  });

  it('село считается точкой, а не контуром', () => {
    expect(classify({ place: 'village' }, 'n7')).toBe('settlement');
    expect(classify({ place: 'village' }, 'w7')).toBeNull();
    expect(classify({ place: 'village' }, 'a14')).toBeNull();
    expect(classify({ place: 'locality' }, 'n7')).toBeNull();
  });

  it('аптека, магазин и пустые теги точкой помощи не становятся', () => {
    expect(classify({ amenity: 'pharmacy' }, 'n1')).toBeNull();
    expect(classify({ healthcare: 'dentist' }, 'n1')).toBeNull();
    expect(classify({ shop: 'bakery' }, 'n1')).toBeNull();
    expect(classify({}, 'n1')).toBeNull();
    expect(classify(null, 'n1')).toBeNull();
  });

  it('объект с двумя подходящими тегами получает один род — тот, где помощь ближе', () => {
    expect(classify({ amenity: 'hospital', emergency: 'phone' }, 'n1')).toBe('medical');
    expect(classify({ tourism: 'alpine_hut', emergency: 'mountain_rescue' }, 'n1')).toBe('rescue');
  });
});

describe('координата и ключ объекта', () => {
  it('центр — середина охвата у точки, линии и площади', () => {
    expect(centerOf({ type: 'Point', coordinates: [158, 54] })).toEqual({ lat: 54, lng: 158 });
    expect(centerOf({ type: 'LineString', coordinates: [[158, 53], [160, 55]] })).toEqual({ lat: 54, lng: 159 });
    expect(centerOf({ type: 'MultiPolygon', coordinates: [[[[158, 53], [160, 53], [160, 55], [158, 53]]]] }))
      .toEqual({ lat: 54, lng: 159 });
  });

  it('геометрия без координат — «не знаю», а не ноль-ноль', () => {
    expect(centerOf(null)).toBeNull();
    expect(centerOf({ type: 'Point', coordinates: [] })).toBeNull();
    expect(centerOf({ type: 'GeometryCollection' })).toBeNull();
  });

  it('площадь сводится к своей линии или отношению', () => {
    expect(canonicalId('a22')).toBe('w11');
    expect(canonicalId('a23')).toBe('r11');
    expect(canonicalId('w11')).toBe('w11');
    expect(canonicalId('n5')).toBe('n5');
  });

  it('расстояние от города: сам город — ноль, Ключи — дальше 200 км', () => {
    expect(distanceKm(CITY, CITY)).toBe(0);
    expect(distanceKm(CITY, { lat: 56.32, lng: 160.84 })).toBeGreaterThan(300);
    expect(BANDS.map((b: { maxKm: number }) => b.maxKm)).toEqual([50, 200, Infinity]);
  });
});

describe('счёт', () => {
  const sample = [
    point('n100', { tourism: 'alpine_hut', name: 'Приют Тест' }),
    point('n101', { amenity: 'shelter', shelter_type: 'public_transport' }, 158.65, 53.02),
    point('n103', { place: 'village', name: 'Село' }, 160.84, 56.32),
    point('n104', { amenity: 'ranger_station', name: 'Кордон', phone: '+70000000000' }, 159.5, 54.5),
    point('n105', { amenity: 'shelter' }, 158.2, 53.5),
    { type: 'Feature', id: 'w11', geometry: { type: 'LineString', coordinates: [[158.6, 53.0], [158.61, 53.01]] }, properties: { amenity: 'hospital', name: 'Больница' } },
    { type: 'Feature', id: 'a22', geometry: { type: 'MultiPolygon', coordinates: [[[[158.6, 53.0], [158.61, 53.0], [158.61, 53.01], [158.6, 53.0]]]] }, properties: { amenity: 'hospital', name: 'Больница' } },
    point('n106', { shop: 'bakery' }),
  ];

  it('считает по родам, с именем, с телефоном и по удалённости', async () => {
    const r = await readCensus(seq(sample));
    expect(r.lines).toBe(8);
    expect(r.broken).toBe(0);
    expect(r.matched).toBe(5);
    expect(r.transit).toBe(1);
    expect(r.byKind.hut).toMatchObject({ count: 1, named: 1, phone: 0 });
    expect(r.byKind.ranger).toMatchObject({ count: 1, named: 1, phone: 1 });
    expect(r.byKind.shelter).toMatchObject({ count: 1, named: 0 });
    expect(r.byKind.settlement.bands).toEqual({ near: 0, mid: 0, far: 1 });
    expect(r.byKind.medical.bands).toEqual({ near: 1, mid: 0, far: 0 });
    expect(r.shelterTypes).toEqual({ 'не указан': 1 });
  });

  it('больница, нарисованная зданием, считается один раз', async () => {
    const r = await readCensus(seq(sample));
    expect(r.byKind.medical.count).toBe(1);
    expect(r.repeats).toBe(1);
  });

  it('точка без координат в счёт не входит и названа', () => {
    const r = emptyCensus();
    expect(addFeature(r, { type: 'Feature', id: 'n1', geometry: null, properties: { tourism: 'alpine_hut' } })).toBeNull();
    expect(r.noGeometry).toBe(1);
    expect(r.matched).toBe(0);
  });

  it('битая строка не глотается: она в счёте битых', async () => {
    const r = await readCensus([...seq(sample), '{"type":"Feature",']);
    expect(r.broken).toBe(1);
    expect(r.matched).toBe(5);
  });

  it('пустые строки строками выгрузки не считаются', async () => {
    const r = await readCensus(['', '  ', ...seq([sample[0]])]);
    expect(r.lines).toBe(1);
  });
});

describe('отчёт', () => {
  it('первой строкой называет область; каждый род — строкой, и нулевой тоже', async () => {
    const r = await readCensus(seq([point('n100', { tourism: 'alpine_hut', name: 'Приют Тест' })]));
    const lines = formatReport(r, 'граница края');
    expect(lines[0]).toBe('Область: граница края.');
    for (const k of KINDS) {
      expect(lines.some((l: string) => l.startsWith(`${k.label} | `)), k.key).toBe(true);
    }
    expect(lines.find((l: string) => l.startsWith('пожарные части'))).toMatch(/\| 0 \| 0 \| 0 \| 0 \| 0 \| 0$/);
  });

  it('говорит, чего карта не знает, и не называет точки безопасными', async () => {
    const r = await readCensus(seq([point('n100', { tourism: 'alpine_hut' })]));
    const text = formatReport(r, 'x').join('\n');
    expect(text).toContain('работает ли точка и есть ли там люди — карта этого не знает');
    expect(text).not.toMatch(/безопасн/i);
  });

  it('контроль вырезки назван строкой: все на месте или кого нет', async () => {
    const full = await readCensus(seq(control()));
    expect(missingControl(full)).toEqual([]);
    expect(formatReport(full, 'x')).toContain(`Контроль вырезки: все ${CONTROL_SETTLEMENTS.length} контрольных населённых пунктов на месте.`);
    const partial = await readCensus(seq(control().filter((f) => f.properties.name !== 'Палана')));
    expect(missingControl(partial)).toEqual(['Палана']);
    expect(formatReport(partial, 'x').join('\n')).toContain('Контроль вырезки НЕ пройден: нет Палана');
  });

  it('контрольные пункты стоят по краям карты, а не в одном городе', () => {
    expect(CONTROL_SETTLEMENTS).toContain('Петропавловск-Камчатский');
    expect(CONTROL_SETTLEMENTS).toContain('Никольское');
    expect(CONTROL_SETTLEMENTS.length).toBeGreaterThanOrEqual(6);
  });

  it('приют без имени так и подписан, с координатой и номером объекта', async () => {
    const r = await readCensus(seq([point('n100', { tourism: 'wilderness_hut' }, 158.1234, 54.5678)]));
    expect(formatReport(r, 'x')).toContain('hut | без имени | 54.568, 158.123 | 176 км | n100');
  });

  it('длинный список режется вслух: остаток назван числом', async () => {
    const many = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => point(`n${i + 1}`, { tourism: 'alpine_hut' }));
    const lines = formatReport(await readCensus(seq(many)), 'x');
    expect(lines.filter((l: string) => l.startsWith('hut | ')).length).toBe(LIST_LIMIT);
    expect(lines).toContain('…и ещё 3 — не напечатаны, в счёте выше они есть.');
    expect(lines.find((l: string) => l.startsWith('приюты и избы'))).toContain(`| ${LIST_LIMIT + 3} |`);
  });

  it('медицина и сёла поимённо не печатаются — только числом', async () => {
    const r = await readCensus(seq([point('n1', { amenity: 'hospital', name: 'Больница' }), point('n2', { place: 'village', name: 'Село' })]));
    const lines = formatReport(r, 'x');
    expect(lines.some((l: string) => l.includes('Больница') || l.includes('Село'))).toBe(false);
  });
});

describe('программа: код выхода', () => {
  const dir = mkdtempSync(join(tmpdir(), 'help-census-'));
  const file = (name: string, lines: string[]) => {
    const p = join(dir, name);
    writeFileSync(p, lines.join('\n'));
    return p;
  };
  const run = async (argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const code = await main({ argv, log: (s: string) => out.push(s), error: (s: string) => err.push(s) });
    return { code, out, err };
  };

  it('без пути к выгрузке — 2 и подсказка', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err.join(' ')).toContain('Нужно:');
  });

  it('файла нет — 1: перепись не выполнялась', async () => {
    const r = await run([join(dir, 'нет.seq'), 'x']);
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('Перепись не выполнялась');
    expect(r.out.some((l) => l.startsWith('Итог: '))).toBe(false);
  });

  it('ноль точек на весь край — 1, а не «пусто»', async () => {
    const empty = await run([file('empty.seq', []), 'x']);
    expect(empty.code).toBe(1);
    const none = await run([file('none.seq', seq([point('n1', { shop: 'bakery' })])), 'x']);
    expect(none.code).toBe(1);
    expect(none.err.join(' ')).toContain('поломка выгрузки или фильтра');
    expect(none.out.some((l) => l.startsWith('Итог: '))).toBe(false);
  });

  it('битая строка — 1, даже если точки нашлись', async () => {
    const r = await run([file('broken.seq', [...seq([point('n1', { tourism: 'alpine_hut' })]), '{oops']), 'x']);
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('нечитаемых строк');
    expect(r.out.some((l) => l.startsWith('Итог: '))).toBe(false);
  });

  it('точки есть — 0 и строка итога', async () => {
    const r = await run([file('ok.seq', seq([point('n1', { tourism: 'alpine_hut' }), point('n2', { place: 'town' }, 160.84, 56.32), ...control()])), 'граница края']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('Область: граница края.');
    expect(r.out.at(-1)).toBe(`Итог: точек помощи ${2 + CONTROL_SETTLEMENTS.length}, из них дальше 200 км от Петропавловска 1.`);
  });

  it('вырезка без контрольного села — 1: точки есть, а верить им нельзя', async () => {
    const partial = control().filter((f) => f.properties.name !== 'Петропавловск-Камчатский');
    const r = await run([file('partial.seq', seq([point('n1', { tourism: 'alpine_hut' }), ...partial])), 'граница края']);
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('Вырезка неполна');
    expect(r.err.join(' ')).toContain('Петропавловск-Камчатский');
    expect(r.out.some((l) => l.startsWith('Итог: '))).toBe(false);
  });

  it('режим границы: из всех контуров файла берётся один — контур края', async () => {
    const lines = seq([
      polygon({ admin_level: '6', name: 'Район' }),
      polygon({ 'ISO3166-2': REGION_ISO, admin_level: '4', name: 'Край' }),
      polygon({ admin_level: '8', name: 'Поселение' }, 'Polygon'),
    ]);
    const picked = await pickBoundary(lines);
    expect(picked.feature?.properties).toEqual({ 'ISO3166-2': REGION_ISO });
    expect(picked.feature?.geometry.type).toBe('MultiPolygon');
    const to = join(dir, 'krai.geojson');
    const r = await run(['--boundary', file('contours.seq', lines), to]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(to, 'utf8')) as { type: string; properties: Tags };
    expect(written.type).toBe('Feature');
    expect(written.properties).toEqual({ 'ISO3166-2': REGION_ISO });
  });

  it('режим границы: нет контура, их два или строка не читается — отказ с причиной', async () => {
    expect((await pickBoundary(seq([polygon({ admin_level: '6' })]))).reason).toContain('в выгрузке нет');
    const two = seq([polygon({ 'ISO3166-2': REGION_ISO }), polygon({ 'ISO3166-2': REGION_ISO })]);
    expect((await pickBoundary(two)).reason).toContain('несколько');
    expect((await pickBoundary([...seq([polygon({ 'ISO3166-2': REGION_ISO })]), '{oops'])).reason).toContain('нечитаемых');
    // Точка с кодом края — не контур.
    expect((await pickBoundary(seq([point('n1', { 'ISO3166-2': REGION_ISO })]))).feature).toBeUndefined();
    const to = join(dir, 'none.geojson');
    const r = await run(['--boundary', file('no-contour.seq', seq([polygon({ admin_level: '6' })])), to]);
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('Граница края не получена');
    expect((await run(['--boundary'])).code).toBe(2);
    expect((await run(['--boundary', join(dir, 'нет.seq'), to])).code).toBe(1);
  });

  it('область не названа — отчёт говорит это, а не молчит', async () => {
    const r = await run([file('ok2.seq', seq([point('n1', { tourism: 'alpine_hut' })]))]);
    expect(r.out[0]).toBe('Область: не названа.');
  });

  it('запуск настоящим node: код выхода и итог — и по ссылке на каталог', () => {
    const ok = file('cli.seq', seq([point('n1', { tourism: 'alpine_hut' }), ...control()]));
    const direct = spawnSync('node', [SCRIPT, ok, 'граница края'], { encoding: 'utf8' });
    expect(direct.status).toBe(0);
    expect(direct.stdout).toContain(`Итог: точек помощи ${1 + CONTROL_SETTLEMENTS.length}`);
    const link = join(dir, 'repo-link');
    symlinkSync(ROOT, link);
    const viaLink = spawnSync('node', [join(link, 'scripts/help-points-osm-census.mjs'), ok, 'x'], { encoding: 'utf8' });
    expect(viaLink.status).toBe(0);
    expect(viaLink.stdout).toContain(`Итог: точек помощи ${1 + CONTROL_SETTLEMENTS.length}`);
    const red = spawnSync('node', [SCRIPT, file('cli-empty.seq', []), 'x'], { encoding: 'utf8' });
    expect(red.status).toBe(1);
    expect(red.stdout).not.toContain('Итог: ');
  });
});

describe('workflow', () => {
  interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string> }
  interface Wf {
    on: { push?: { branches?: string[]; paths?: string[] }; [k: string]: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, { permissions?: Record<string, string>; steps: Step[]; 'timeout-minutes'?: number }>;
  }
  const requireCjs = createRequire(import.meta.url);
  const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };
  const src = readFileSync(WORKFLOW, 'utf8');
  const wf = load(src) as Wf;
  const steps = wf.jobs.census.steps;
  const extract = steps.find((s) => s.name?.startsWith('Выгрузка Geofabrik'))!;
  const census = steps.find((s) => s.name?.startsWith('Перепись'))!;

  it('шаги найдены и это разные шаги: выгрузка не зовёт скрипт, перепись не зовёт сеть', () => {
    expect(extract).toBeDefined();
    expect(census).toBeDefined();
    expect(census).not.toBe(extract);
    expect(census.run).not.toMatch(/curl|apt-get|osmium/);
    expect(extract.run).toMatch(/osmium extract/);
    expect(census.run).toMatch(/node scripts\/help-points-osm-census\.mjs "\$T\/kam\.geojsonseq"/);
  });

  it('запускается только правкой своего маркера в main', () => {
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.on.push?.branches).toEqual(['main']);
    expect(wf.on.push?.paths).toEqual(['.github/triggers/help-points-osm-census.json']);
  });

  it('только чтение: прав на запись нет, секретов не берёт, прод не зовёт', () => {
    expect(wf.permissions).toEqual({});
    expect(wf.jobs.census.permissions).toEqual({ contents: 'read' });
    expect(src).not.toMatch(/secrets\./);
    expect(src).not.toMatch(/vedarai\.ru/);
    expect(src).not.toMatch(/DATABASE_URL|CRON_SECRET/);
    expect(wf.jobs.census['timeout-minutes']).toBeGreaterThan(0);
  });

  it('маркер: номер прогона и причина словами', () => {
    const marker = JSON.parse(readFileSync(MARKER, 'utf8')) as Record<string, unknown>;
    expect(typeof marker.run).toBe('number');
    expect(String(marker[`run${marker.run}_reason`] ?? '').length).toBeGreaterThan(40);
  });

  it('фильтр выгрузки пропускает каждый тег, который читает скрипт', () => {
    // Выражения osmium tags-filter: `nwr/key` — любой объект с ключом,
    // `nwr/key=a,b` — с одним из значений, `n/…` — только точки.
    const exprs = [...extract.run!.matchAll(/\b(nwr|n)\/([a-z_:]+)(?:=([a-z_,]+))?/g)]
      .map((m) => ({ types: m[1], key: m[2], values: m[3] ? m[3].split(',') : null }))
      .filter((e) => e.key !== 'ISO3166-2');
    expect(exprs.length).toBeGreaterThan(3);
    for (const t of READ_TAGS as { key: string; value: string; kind: string }[]) {
      const passes = exprs.some((e) => e.key === t.key && (e.values === null || e.values.includes(t.value)));
      expect(passes, `${t.key}=${t.value} не проходит фильтр выгрузки`).toBe(true);
    }
    // Сёла фильтр берёт только точками — как и скрипт.
    expect(exprs.filter((e) => e.key === 'place').every((e) => e.types === 'n')).toBe(true);
  });

  /** Подложенные команды: osmium пишет свои аргументы в журнал и создаёт выходной файл. */
  function stubBin(opts: { boundary: number; extractByBoundary: number }) {
    const dir = mkdtempSync(join(tmpdir(), 'help-wf-'));
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    const log = join(dir, 'osmium.log');
    const write = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/bash\n${body}\n`);
      chmodSync(p, 0o755);
    };
    write('sudo', 'exit 0');
    write('curl', 'out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done; echo pbf > "$out"');
    write('osmium', [
      `echo "$*" >> "${log}"`,
      'out=""; args=("$@"); for ((i=0;i<${#args[@]};i++)); do if [ "${args[$i]}" = "-o" ]; then out="${args[$((i+1))]}"; fi; done',
      `if [ "$1" = "extract" ] && [ "$2" = "-p" ]; then [ "${opts.extractByBoundary}" = "0" ] || exit ${opts.extractByBoundary}; fi`,
      '[ -n "$out" ] && echo data > "$out"',
      'exit 0',
    ].join('\n'));
    // Подложенный node: режим --boundary отвечает заданным кодом и при успехе пишет контур.
    write('node', [
      `echo "node $*" >> "${log}"`,
      `if [ "$2" = "--boundary" ]; then [ "${opts.boundary}" = "0" ] && echo contour > "$4"; exit ${opts.boundary}; fi`,
      'exit 0',
    ].join('\n'));
    return { dir, bin, log };
  }

  function runExtract(opts: { boundary: number; extractByBoundary: number }) {
    const { dir, bin, log } = stubBin(opts);
    const env = join(dir, 'github-env');
    writeFileSync(env, '');
    const r = spawnSync('bash', ['-e', '-c', extract.run!], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ENV: env },
    });
    return { status: r.status, stdout: r.stdout, calls: readFileSync(log, 'utf8'), area: readFileSync(env, 'utf8') };
  }

  it('граница края нашлась — режем по одному её контуру, отчёту передана «граница»', () => {
    const r = runExtract({ boundary: 0, extractByBoundary: 0 });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^node scripts\/help-points-osm-census\.mjs --boundary /m);
    expect(r.calls).toMatch(/^extract -p \S+\/krai\.geojson /m);
    expect(r.calls).not.toMatch(/^extract -b /m);
    expect(r.area).toMatch(/^AREA=граница Камчатского края/);
  });

  it('вырезке не отдаётся файл со всеми контурами: вложенные она считает по чёт-нечет', () => {
    const r = runExtract({ boundary: 0, extractByBoundary: 0 });
    expect(r.calls).not.toMatch(/^extract -p \S+\.osm\.pbf /m);
    expect(r.calls).not.toMatch(/^extract -p \S+\.geojsonseq /m);
  });

  it('контура края в выгрузке нет — рамка всего края, и отчёт получает это словами', () => {
    const r = runExtract({ boundary: 1, extractByBoundary: 0 });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^extract -b 155,50,174\.5,65\.5 /m);
    expect(r.calls).not.toMatch(/^extract -p /m);
    expect(r.area).toMatch(/^AREA=рамка /);
    expect(r.area).toContain('граница края не применена');
    expect(r.area).toContain('Северные Курилы');
    expect(r.area).toContain('Чукотки');
    expect(r.stdout).toContain('::warning::');
  });

  it('вырезка по границе упала — тоже рамка, а не красный шаг и не молчание', () => {
    const r = runExtract({ boundary: 0, extractByBoundary: 1 });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^extract -b 155,50,174\.5,65\.5 /m);
    expect(r.area).toMatch(/^AREA=рамка /);
  });

  function runCensus(nodeStub: string, area = 'граница края') {
    const dir = mkdtempSync(join(tmpdir(), 'help-step-'));
    const node = join(dir, 'node');
    writeFileSync(node, `#!/bin/bash\n${nodeStub}\n`);
    chmodSync(node, 0o755);
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const r = spawnSync('bash', ['-e', '-c', census.run!], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, AREA: area },
    });
    return { status: r.status, stdout: r.stdout, summary: readFileSync(summary, 'utf8') };
  }

  it('скрипт получает выгрузку и подпись области', () => {
    const r = runCensus('echo "ARGS: $1 | $2 | $3"; echo "Итог: точек помощи 1"; exit 0', 'рамка 155–167°');
    expect(r.stdout).toMatch(/ARGS: scripts\/help-points-osm-census\.mjs \| .*kam\.geojsonseq \| рамка 155–167°/);
  });

  it('красный исход скрипта — красный шаг, и сводка написана', () => {
    const r = runCensus('echo "Область: x."; exit 1');
    expect(r.status).toBe(1);
    expect(r.summary).toContain('## Точки помощи по OpenStreetMap');
    expect(r.summary).toContain('Область: x.');
  });

  it('код 0 без строки итога — красный: перепись не выполнялась', () => {
    const r = runCensus('exit 0');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
  });

  it('код 0 со строкой итога — зелёный, итог в сводке', () => {
    const r = runCensus('echo "Итог: точек помощи 7, из них дальше 200 км от Петропавловска 2."; exit 0');
    expect(r.status).toBe(0);
    expect(r.summary).toContain('Итог: точек помощи 7');
  });
});
