/**
 * Сторож текста «Как добраться» (решение владельца 02.10).
 *
 * Правило: каждое предложение — из своего факта; нет факта — нет
 * предложения. Дорога (`road_type`/`road_accessibility`) не упоминается:
 * у всех мест это умолчание миграции 0645, а не замер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { composeAccessText, bearingDeg, directionWord, PK, type AccessFacts } from '@/lib/places/access-text';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const geysers: AccessFacts = {
  name: 'Долина гейзеров',
  lat: 54.43, lng: 160.14,
  district: null,
  zone: 'Кроноцкий заповедник',
  accessInfo: 'Только вертолётом в составе экскурсии',
  routes: [
    { title: 'Долина гейзеров (вертолёт)', distanceKm: null, durationHours: 6, difficulty: 'easy' },
    { title: 'Тропа по долине', distanceKm: 2.5, durationHours: 1.5, difficulty: 'easy' },
  ],
  registrationRequired: true,
  eco: { zone: 'federal_reserve', permitRequired: true },
  toursCount: 2,
};

describe('направление от города', () => {
  it('румбы: север, восток, юго-запад', () => {
    expect(directionWord(0)).toBe('северу');
    expect(directionWord(90)).toBe('востоку');
    expect(directionWord(225)).toBe('юго-западу');
    expect(directionWord(359)).toBe('северу');
  });
  it('Долина гейзеров — к северо-востоку от Петропавловска', () => {
    expect(directionWord(bearingDeg(PK, geysers))).toBe('северо-востоку');
  });
});

describe('текст из фактов', () => {
  it('полный набор: где, записанный текст, маршруты, допуск, туры — по порядку', () => {
    const t = composeAccessText(geysers);
    expect(t[0]).toMatch(/^Долина гейзеров — в \d+ км по прямой к северо-востоку от Петропавловска-Камчатского, Кроноцкий заповедник\.$/);
    expect(t[1]).toBe('Только вертолётом в составе экскурсии.');
    expect(t[2]).toBe('Через место проходят 2 маршрута каталога; самый короткий — «Тропа по долине», 2,5 км, около 1,5 ч, лёгкий.');
    expect(t[3]).toBe('Перед выходом нужна регистрация в МЧС, посещение — по разрешению дирекции государственного заповедника.');
    expect(t[4]).toBe('Сюда возят 2 тура операторов платформы — ссылки ниже.');
    expect(t).toHaveLength(5);
  });

  it('без фактов — одно предложение о расположении, ничего выдуманного', () => {
    const t = composeAccessText({ ...geysers, zone: null, accessInfo: null, routes: [], registrationRequired: false, eco: null, toursCount: 0 });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/^Долина гейзеров — в \d+ км по прямой к северо-востоку от Петропавловска-Камчатского\.$/);
  });

  it('один маршрут без километров — назван без цифр; рядом с городом — «в черте или рядом»', () => {
    const t = composeAccessText({ ...geysers, zone: null, accessInfo: null, registrationRequired: false, eco: null, toursCount: 0,
      routes: [{ title: 'Подъём', distanceKm: null, durationHours: null, difficulty: null }] });
    expect(t[1]).toBe('Через место проходит маршрут каталога «Подъём».');
    const near = composeAccessText({ ...geysers, lat: 53.05, lng: 158.60, zone: null, accessInfo: null, routes: [], registrationRequired: false, eco: null, toursCount: 0 });
    expect(near[0]).toBe('Долина гейзеров — в черте Петропавловска-Камчатского или рядом с ним.');
  });

  it('территория без разрешения — названа как территория; один тур — единственное число', () => {
    const t = composeAccessText({ ...geysers, accessInfo: null, routes: [], registrationRequired: false, eco: { zone: 'natural_park', permitRequired: false }, toursCount: 1 });
    expect(t[1]).toBe('Место на территории природного парка.');
    expect(t[2]).toBe('Сюда возит один тур оператора платформы — ссылка ниже.');
  });

  it('о дороге — ни слова: road_type/road_accessibility не замер, а умолчание', () => {
    const src = read('lib/places/access-text.ts');
    // Идентификаторы полей дороги в коде не читаются; упоминание в шапке —
    // объяснение, почему их нет, и оно разрешено.
    const code = src.slice(src.indexOf('import { distanceKm }'));
    expect(code).not.toMatch(/roadType|roadAccessibility|road_type|road_accessibility|гравий/i);
    expect(src).toContain("lib/places/on-route.ts");
  });
});

describe('связка с карточкой', () => {
  it('текст рисует сама карточка в первом HTML, а не блок без SSR', () => {
    const card = read('app/places/[id]/_PlaceDetailClient.tsx');
    expect(card).toContain("import { composeAccessText } from '@/lib/places/access-text';");
    expect(card).toMatch(/<Section title="Как добраться">[\s\S]*?composeAccessText\(\{[\s\S]*?\}\)\.join\(' '\)[\s\S]*?<PlaceAccess/);
    expect(card).toMatch(/PlaceAccess\s*=\s*dynamic\([\s\S]*?ssr: false/);
    const access = read('components/places/PlaceAccess.tsx');
    expect(access).not.toContain('accessInfo');
  });
});

/**
 * Батарея Максутова, 03.10 (владелец: «это всё далеко, а не 1.6 км»): «Как
 * добраться» печатало «через место проходят 3 маршрута каталога; самый
 * короткий — „Скалы Три Брата“, 1,6 км». Все три были связью «рядом»
 * (миграция 167, «в 15 км от центра маршрута»), а 1,6 км — длина самого
 * маршрута. Через место «рядом» не идёт (§4.1).
 */
describe('«рядом» не выдаётся за маршрут через место', () => {
  it('только «рядом» — предложения о маршрутах нет вовсе', () => {
    const text = composeAccessText({
      name: 'Батарея Максутова', lat: 53.0203, lng: 158.6422, district: null, zone: null, accessInfo: null,
      routes: [
        { title: 'Скалы Три Брата', distanceKm: 1.6, durationHours: null, difficulty: 'easy', linkKind: 'nearby' },
        { title: 'Озеро Приливное – Халактырский пляж', distanceKm: 11.3, durationHours: 3, difficulty: 'easy', linkKind: 'nearby' },
      ],
      registrationRequired: false, eco: null, toursCount: 0,
    }).join(' ');
    expect(text).not.toMatch(/Через место/);
    expect(text).not.toMatch(/Три Брата/);
  });

  it('путевые и неразмеченные считаются, «рядом» — нет', () => {
    const text = composeAccessText({
      name: 'X', lat: 53.0203, lng: 158.6422, district: null, zone: null, accessInfo: null,
      routes: [
        { title: 'Путь', distanceKm: 5, durationHours: null, difficulty: null, linkKind: 'waypoint' },
        { title: 'Рядом', distanceKm: 1, durationHours: null, difficulty: null, linkKind: 'nearby' },
      ],
      registrationRequired: false, eco: null, toursCount: 0,
    }).join(' ');
    expect(text).toContain('Через место проходит маршрут каталога «Путь»');
    expect(text).not.toContain('Рядом');
  });

  it('род связи доходит до карточки, список делится, туры «рядом» не берут', () => {
    const detail = readFileSync(`${process.cwd()}/lib/places/place-detail.ts`, 'utf8');
    expect(detail).toMatch(/linkKind: \(rt\.link_kind as/);
    const toursAt = detail.indexOf('const toursResult = await query(');
    expect(detail.slice(toursAt, toursAt + 1200)).toContain("COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'");
    const list = readFileSync(`${process.cwd()}/components/places/PlaceRoutes.tsx`, 'utf8');
    expect(list).toContain("routes.filter(r => r.linkKind !== 'nearby')");
    expect(list).toContain('Через само место они не проходят');
  });
});
