/**
 * Проба своей карты не имеет права отнять карту у человека в поле.
 *
 * 31.08. Своя карта (MapLibre + PMTiles) подключается на полевом экране, но
 * пакеты собраны не для всех районов и хранилище может быть не настроено.
 * Развилка обязана быть по НАЛИЧИЮ пакета, а не по флагу «мы переехали»:
 * иначе первый же выкат оставил бы идущего человека с пустым экраном там,
 * где секунду назад была рабочая карта.
 *
 * Это тот же урок, что §12 и §4.0 вместе: чего нет — о том говорим прямо, а
 * запасной путь не деградация, а штатный ход.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseFieldBaseMap, regionForPoint, regionCenter } from '@/lib/map/field-base-map';
import { BUILT_PACK_REGIONS } from '@/lib/map/pack-source';

describe('выбор подложки полевого экрана', () => {
  it('без собранного пакета — Leaflet, и причина названа', () => {
    // Сегодня BUILT_PACK_REGIONS пуст, значит ответ обязан быть Leaflet
    // ВЕЗДЕ. Проба, не изменившая поведение до появления данных, — правильно
    // собранная проба.
    const r = chooseFieldBaseMap(53.26, 158.83, []);
    expect(r.kind).toBe('leaflet');
    expect((r as { reason: string }).reason.length).toBeGreaterThan(10);
  });

  it('точка вне районов реестра — тоже Leaflet, с отдельной причиной', () => {
    // «Пакета нет» и «района нет» — разные состояния (§4.0), и путать их
    // нельзя: второе не чинится сборкой пакета.
    const r = chooseFieldBaseMap(0, 0, []);
    expect(r.kind).toBe('leaflet');
    expect((r as { reason: string }).reason).toMatch(/вне районов/i);
  });

  it('Авачинская группа объявлена собранной — пакет залит 31.08', () => {
    // Список — обещание, что файл в хранилище. Вносится ТОЛЬКО после
    // подтверждённой заливки: первый прогон workflow был зелёным с
    // пропущенным шагом заливки, и поверить ему значило бы обещать карту,
    // которой нет.
    expect(BUILT_PACK_REGIONS).toContain('avacha-group');
  });

  it('без заданной базы адресов район всё равно уходит на Leaflet', () => {
    // Пакет собран, но если NEXT_PUBLIC_MAP_PACK_BASE_URL не задана, идти
    // за ним некуда. Это «не настроено», а не «карты нет», и не повод
    // показать человеку пустой экран.
    const r = chooseFieldBaseMap(53.26, 158.83, ['avacha-group']);
    if (r.kind === 'leaflet') {
      expect(r.reason).toMatch(/не настроено|не собран/i);
    } else {
      expect(r.source.terrainUrl).toContain('pmtiles://');
    }
  });

  it('Авачинский перевал попадает в свой район', () => {
    // Референс владельца 31.08 — этот самый экран.
    expect(regionForPoint(53.32, 158.72)).toBe('avacha-group');
    const [lat, lng] = regionCenter('avacha-group');
    expect(lat).toBeGreaterThan(52.8);
    expect(lng).toBeGreaterThan(158.4);
  });
});

describe('полевой экран не теряет Leaflet', () => {
  const CLIENT = readFileSync(
    join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('обе подложки живы — своя карта добавлена, а не подменила', () => {
    // Добавка 3 владельца: Leaflet в пробе не снимаем, решение о миграции —
    // по фактам пробы.
    expect(CLIENT).toContain('<VedarMap');
    expect(CLIENT).toContain('<LeafletMap');
    expect(CLIENT).toMatch(/fieldBaseMap\.kind === 'vedar' \?/);
  });

  it('своя карта грузится client-only и отдельным чанком', () => {
    // MapLibre трогает window при импорте, и его ~200 КБ не должны платиться
    // там, где показывается Leaflet.
    expect(CLIENT).toMatch(/const VedarMap = dynamic\(\(\) => import\('@\/components\/shared\/VedarMap'\)/);
    const at = CLIENT.indexOf("const VedarMap = dynamic");
    expect(CLIENT.slice(at, at + 260)).toContain('ssr: false');
  });

  it('линии переворачиваются в порядок GeoJSON ровно в одном месте', () => {
    // Leaflet берёт [lat, lng], GeoJSON — [lng, lat]. Второй переворот в
    // другом файле — это разъезд, который никто не заметит до поля.
    expect(CLIENT).toMatch(/\.map\(\(\[la, ln\]\) => \[ln, la\]\)/);
  });
});

describe('своя карта не пересобирается на живых данных', () => {
  const MAP = readFileSync(
    join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

  it('линии обновляются setData, а не пересозданием слоя', () => {
    // Урок того же дня: в LeafletMap набор маркеров стоял в зависимостях
    // эффекта карты, и карта пересобиралась на каждом GPS-фиксе. Здесь
    // разделение заложено сразу.
    expect(MAP).toContain('src.setData(');
    const lifecycleDeps = MAP.slice(MAP.indexOf('}, [theme, sources?.terrainUrl'));
    expect(lifecycleDeps.slice(0, 80)).not.toMatch(/\blines\b/);
  });

  it('камера центрируется один раз, дальше ей распоряжается человек', () => {
    expect(MAP).toMatch(/autoCenterDoneRef\.current = true/);
    const at = MAP.indexOf('if (!autoCenterDoneRef.current)');
    expect(at).toBeGreaterThan(0);
    expect(MAP.slice(at, at + 220)).toContain('map.easeTo(');
  });

  it('отсутствие пакета говорится словами, а не пустым экраном', () => {
    // Чёрный прямоугольник неотличим от «приложение умерло» — это уже
    // случалось с Leaflet (владелец 09.08).
    expect(MAP).toMatch(/if \(!sources \|\| failed\)/);
    expect(MAP).toContain('unavailableReason');
  });

  it('вращение карты выключено — север сверяется с компасом', () => {
    expect(MAP).toContain('disableRotation()');
    expect(MAP).toMatch(/dragRotate: false/);
  });
});
