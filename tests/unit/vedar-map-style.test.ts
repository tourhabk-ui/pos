/**
 * Своя карта: стиль читает данные, а не рисует похожее.
 *
 * Проба 31.08. Владелец принёс референс тёмной топоподложки и спросил, какой
 * графический ИИ её нарисует. Ответ — никакой: карта это функция (зум, bbox,
 * данные) -> пиксели, а генеративная модель выдаёт кадр. Опаснее вида то, что
 * модель ВЫДУМАЕТ горизонтали: правдоподобный узор вместо рельефа, на экране,
 * по которому человек идёт (§4.0, тот же класс, что и линия, обещающая
 * проходимость, — §12).
 *
 * Поэтому здесь стерегутся черты, отличающие карту от картинки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVedarStyle, vedarMapPalette } from '@/lib/map/vedar-style';
import { packKey, resolvePackSource } from '@/lib/map/pack-source';

const SRC = {
  terrainUrl: 'pmtiles://https://example.test/map-packs/avacha-group.terrain.pmtiles',
  contoursUrl: 'https://example.test/map-packs/avacha-group.contours.geojson',
  terrainMaxZoom: 12,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: 'https://example.test/glyphs/{fontstack}/{range}.pbf',
};

/** Тот же набор, но без глифов — как сегодня на проде. */
const SRC_NO_GLYPHS = { ...SRC, glyphsUrl: null };

type Layer = { id: string; type: string; source?: string; layout?: Record<string, unknown>;
  paint?: Record<string, unknown>; filter?: unknown; minzoom?: number };

function layers(theme: 'dark' | 'light'): Layer[] {
  return (buildVedarStyle(theme, SRC) as { layers: Layer[] }).layers;
}

describe('подписи горизонталей приходят из данных', () => {
  it('text-field читает свойство ele, а не строку', () => {
    const label = layers('dark').find(l => l.id === 'contour-label');
    expect(label).toBeDefined();
    expect(label!.layout!['text-field']).toEqual(['to-string', ['get', 'ele']]);
  });

  it('подписи идут вдоль линии — иначе число висит поперёк склона', () => {
    const label = layers('dark').find(l => l.id === 'contour-label')!;
    expect(label.layout!['symbol-placement']).toBe('line');
    // Перекрытие запрещено: две «1400» друг на друге читаются как одна цифра.
    expect(label.layout!['text-allow-overlap']).toBe(false);
  });

  it('род горизонтали — записанный факт, а не арифметика в стиле', () => {
    // Стиль фильтрует по свойству kind. Считать «ele % 500 === 0» здесь
    // значило бы держать правило в двух местах — сборщик уже решил.
    const major = layers('dark').find(l => l.id === 'contour-major')!;
    expect(major.filter).toEqual(['==', ['get', 'kind'], 'major']);
    const styleText = JSON.stringify(buildVedarStyle('dark', SRC));
    expect(styleText).not.toMatch(/%\s*500|500\s*===/);
  });
});

describe('обе темы — из одного пакета', () => {
  it('источники одинаковы, различается только палитра', () => {
    const d = buildVedarStyle('dark', SRC) as Record<string, unknown>;
    const l = buildVedarStyle('light', SRC) as Record<string, unknown>;
    expect(d.sources).toEqual(l.sources);
    expect(JSON.stringify(d.layers)).not.toEqual(JSON.stringify(l.layers));
  });

  it('рельеф — raster-dem: тень считает клиент, а не запечена в картинке', () => {
    // Запечённый hillshade нёс бы цвет внутри себя, и под две темы
    // понадобилось бы два архива одних и тех же гор.
    const src = (buildVedarStyle('dark', SRC) as {
      sources: { terrain: { type: string; encoding: string; maxzoom: number } } }).sources;
    expect(src.terrain.type).toBe('raster-dem');
    expect(src.terrain.encoding).toBe('mapbox');
    expect(src.terrain.maxzoom).toBe(12);
  });

  it('у светлой темы тень слабее — на солнце слабый сигнал пропадает', () => {
    // Запись платформы про солнце говорит дважды: прозрачность стрелки
    // компаса (21.08) и пунктир линии (§12). Оба раза вывод один — слабый
    // сигнал не годится. Светлая карта не «инверсия», у неё своя мера.
    const ex = (t: 'dark' | 'light') =>
      layers(t).find(l => l.id === 'hillshade')!.paint!['hillshade-exaggeration'] as number;
    expect(ex('light')).toBeLessThan(ex('dark'));
  });
});

describe('атрибуция источника не теряется', () => {
  it('Copernicus назван у обоих источников', () => {
    // Лицензия GLO-90 требует указания правообладателя. Строка идёт из
    // данных стиля, а не пишется в вёрстке руками — забыть её негде.
    const s = buildVedarStyle('dark', SRC) as {
      sources: Record<string, { attribution?: string }> };
    expect(s.sources.terrain.attribution).toContain('Copernicus');
    expect(s.sources.contours.attribution).toContain('Copernicus');
  });

  it('без глифов слоя подписей НЕТ — иначе стиль отвергается целиком', () => {
    // 01.09, полевой прогон: карта рисовала чёрный прямоугольник. Слой
    // подписей просил text-field, а glyphs не был задан вовсе — MapLibre
    // без глифов не может отрисовать текст и отвергает стиль ЦЕЛИКОМ.
    // Пропадали не подписи, а вся карта, включая рельеф.
    const s = buildVedarStyle('dark', SRC_NO_GLYPHS) as
      { glyphs?: unknown; layers: Array<{ id: string; type: string }> };
    expect(s.glyphs).toBeUndefined();
    expect(s.layers.find(l => l.id === 'contour-label')).toBeUndefined();
    // Рельеф и горизонтали при этом на месте — карта без чисел честнее
    // карты, которой нет.
    expect(s.layers.find(l => l.id === 'hillshade')).toBeDefined();
    expect(s.layers.find(l => l.id === 'contour-major')).toBeDefined();
    // Ни один оставшийся слой не просит текст.
    expect(s.layers.some(l => l.type === 'symbol')).toBe(false);
  });

  it('ключ glyphs не выставляется значением undefined', () => {
    // `glyphs: undefined` в объекте — это НАЛИЧИЕ ключа со значением
    // undefined, а не его отсутствие; валидатор стиля трактует их по-разному.
    const s = buildVedarStyle('dark', SRC_NO_GLYPHS) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(s, 'glyphs')).toBe(false);
  });
});

describe('источник пакета называет своё состояние', () => {
  it('не настроено и не собрано — РАЗНЫЕ ответы, и оба не «карты нет»', () => {
    // §4.0: у всякой проверки есть исход «не знаю», и он не равен «плохо».
    const built = resolvePackSource('avacha-group', []);
    expect(built.state).toBe('unconfigured');
    expect((built as { reason: string }).reason).toMatch(/не настроено/i);
  });

  it('ключ объекта считается одной формулой на сборку и на чтение', () => {
    expect(packKey('avacha-group', 'terrain')).toBe('map-packs/avacha-group.terrain.pmtiles');
    expect(packKey('avacha-group', 'contours')).toBe('map-packs/avacha-group.contours.geojson');
  });

  it('список собранных пакетов ведётся явно, а не опросом бакета', () => {
    // Опрос хранилища ради ответа «есть ли офлайн-карта» не пройдёт именно
    // в офлайне — там, где вопрос и задаётся.
    const S = readFileSync(join(process.cwd(), 'lib/map/pack-source.ts'), 'utf-8');
    expect(S).toContain('BUILT_PACK_REGIONS');
    expect(S).not.toMatch(/ListObjects|listObjects|HeadObject/);
  });
});

describe('линия маршрута подчиняется §12, а не решает сама', () => {
  it('построение отличается от снятого трека свойством, а не догадкой', () => {
    const line = layers('dark').find(l => l.id === 'route-line')!;
    expect(JSON.stringify(line.paint!['line-color'])).toContain('connector');
    // Подложка — только у настоящего пути: у пунктирного построения она
    // залила бы просветы и вернула вид снятого трека (§12).
    const casing = layers('dark').find(l => l.id === 'route-casing')!;
    expect(casing.filter).toEqual(['==', ['get', 'connector'], false]);
  });

  it('зумовое выражение стоит верхним уровнем, а не внутри case', () => {
    /**
     * Полевой прогон 01.09. После починки глифов карта ОСТАВАЛАСЬ чёрной, и
     * причину назвала строка ошибки на экране: «requires a "step" or
     * "interpolate" expression». MapLibre не принимает interpolate(['zoom'])
     * вложенным в case и отвергает стиль ЦЕЛИКОМ — снова пропадала не одна
     * линия, а вся карта.
     *
     * Проверяем все paint-свойства всех слоёв: где есть ['zoom'], там
     * interpolate/step обязан быть корнем выражения.
     */
    const zoomNestedInside = (expr: unknown): boolean => {
      if (!Array.isArray(expr)) return false;
      const head = expr[0];
      // Корень-интерполятор законен: его вход и есть зум.
      if (head === 'interpolate' || head === 'step') {
        // Внутри остановок зума быть не должно (там значения, а не вход).
        return expr.slice(3).some(v => containsZoom(v));
      }
      return containsZoom(expr);
    };
    const containsZoom = (expr: unknown): boolean => {
      if (!Array.isArray(expr)) return false;
      if (expr[0] === 'zoom') return true;
      return expr.some(v => containsZoom(v));
    };

    for (const theme of ['dark', 'light'] as const) {
      for (const l of layers(theme)) {
        for (const [prop, value] of Object.entries(l.paint ?? {})) {
          expect(
            zoomNestedInside(value),
            `слой ${l.id}, свойство ${prop}: ['zoom'] не на верхнем уровне`,
          ).toBe(false);
        }
      }
    }
  });

  it('палитра трека — токен --success, а не произвольный зелёный', () => {
    expect(vedarMapPalette('dark').track).toBe('#3FB950');
  });
});

describe('предел зума назван по данным', () => {
  it('в конвейере записано родное разрешение источника', () => {
    const PY = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_terrain.py'), 'utf-8');
    // GLO-90 = 90 м/отсчёт = z10 на широте региона. Печь глубже — рисовать
    // рельеф, которого в данных нет (тот же дефект, что у генеративных
    // моделей, только с нашей подписью).
    expect(PY).toMatch(/NATIVE_ZOOM = 10/);
    expect(PY).toMatch(/MAXZOOM = 12/);
    expect(PY).toContain("'native_zoom': NATIVE_ZOOM");
  });

  it('пустой результат конвейера — отказ, а не успех', () => {
    // §4.0: прогон, разобравший 0 из N, обязан краснеть.
    const PY = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_terrain.py'), 'utf-8');
    expect(PY).toMatch(/НИ ОДНОЙ клетки DEM не получено/);
    const CT = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_contours.py'), 'utf-8');
    expect(CT).toMatch(/НИ ОДНОЙ горизонтали не построено/);
  });
});
