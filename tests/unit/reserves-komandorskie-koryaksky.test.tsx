/**
 * Корякский заповедник и национальный парк «Командорские острова» —
 * владелец 14.10: «Перенеси в Заповедники и сделай также как с [Кроноцким]
 * все заповедники» (миграция 1243, статья летописи «Командорские острова»).
 *
 * Держится то, что делает правку правдой:
 *  - Командорский с 2022 года национальный парк (постановление № 720), и
 *    «Заповедником» его не подписывает ни миграция, ни карточка;
 *  - у описаний голос справки, а не путевой заметки, которую они заменили;
 *  - точки — с источником и только вместо прежних (повтор — no-op);
 *  - снимки залиты до миграции, у каждого автор и лицензия;
 *  - мёртвого komandorsky.ru нет ни в ссылке разрешения, ни в справочнике.
 * Экран судится рендером: статья, блок «Экология и охрана природы».
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import ChronicleArticlePage from '@/app/letopis/[slug]/page';
import PlaceEco from '@/components/places/PlaceEco';
import { CHRONICLE_BY_SLUG, chronicleForPlace } from '@/lib/chronicle/articles';
import { LOCATION_TYPES } from '@/lib/places/location-types';
import { EXCLUDED_TYPES } from '@/lib/stats/element-groups';
import { descriptionVoice } from '@/lib/places/description-voice';
import { ownPermitOf } from '@/lib/places/own-permit';
import { PLACE_MARKER_KINDS, PLACE_KIND_COLOR, placeMarkerSvg } from '@/lib/map/place-marker-icons';

afterEach(cleanup);

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1243_komandorskie_koryaksky_reserves.sql'), 'utf-8');
const KOM = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35';
const KOR = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46';

/** Тело миграции без комментариев — судим то, что исполнится. */
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/** UPDATE places … WHERE id = <id> … — все такие операторы одной записи. */
function updatesOf(id: string): string[] {
  // Оператор кончается «;» в конце строки: в текстах описаний «;» бывает и внутри.
  return BODY.split(/;\s*\n/).filter((s) => /UPDATE places/.test(s) && s.includes(`'${id}'`));
}

/** Склеенный текст описания из `description = '…' || '…'`. */
function descriptionOf(id: string): string {
  const stmt = updatesOf(id).find((s) => /description\s*=/.test(s));
  if (!stmt) return '';
  const part = stmt.split(/description\s*=/)[1].split(/access_info\s*=/)[0];
  return [...part.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")).join('');
}

describe('типы: национальный парк — свой тип, не заповедник', () => {
  it('«Национальный парк» в общем словаре и вне счёта стихий, как заповедник', () => {
    expect(LOCATION_TYPES.national_park).toBe('Национальный парк');
    expect(EXCLUDED_TYPES).toContain('national_park');
    expect(EXCLUDED_TYPES).toContain('reserve');
  });

  it('Командорский становится национальным парком, Корякский — заповедником; оба только из «лесного массива»', () => {
    const kom = updatesOf(KOM).find((s) => /SET location_type/.test(s))!;
    const kor = updatesOf(KOR).find((s) => /SET location_type/.test(s))!;
    expect(kom).toMatch(/location_type = 'national_park'/);
    expect(kom).toMatch(/location_type = 'forest'/);
    expect(kor).toMatch(/location_type = 'reserve'/);
    expect(kor).toMatch(/location_type = 'forest'/);
    for (const s of updatesOf(KOM)) expect(s).not.toMatch(/location_type = 'reserve'|eco_zone = 'federal_reserve'/);
  });

  it('на карте — свой значок охраняемой территории и зелёный, как был у «лесного массива»', () => {
    for (const k of ['reserve', 'national_park']) {
      expect(PLACE_MARKER_KINDS).toContain(k);
      expect(PLACE_KIND_COLOR[k]).toBe(PLACE_KIND_COLOR.forest);
      expect(placeMarkerSvg('#15803D', k)).not.toBe(placeMarkerSvg('#15803D', 'other'));
    }
  });

  it('у Командорского режим охраны — национальный парк, у Корякского — заповедник', () => {
    expect(updatesOf(KOM).join(';')).toMatch(/eco_zone = 'national_park'/);
    expect(updatesOf(KOR).join(';')).toMatch(/eco_zone = 'federal_reserve'/);
  });
});

describe('описания: справка вместо путевой заметки', () => {
  it('прежний текст заменяется только там, где он ещё лежит (повтор — no-op)', () => {
    expect(updatesOf(KOM).find((s) => /description\s*=/.test(s))).toMatch(/description LIKE '%Я стоял на берегу Медного%'/);
    expect(updatesOf(KOR).find((s) => /description\s*=/.test(s))).toMatch(/description LIKE '%тысячи моржовых туш%'/);
  });

  it('голос справки; год преобразования и номер постановления названы', () => {
    const kom = descriptionOf(KOM);
    const kor = descriptionOf(KOR);
    expect(kom.length).toBeGreaterThan(800);
    expect(kor.length).toBeGreaterThan(800);
    expect(descriptionVoice(kom).voice).toBe('plain');
    expect(descriptionVoice(kor).voice).toBe('plain');
    expect(kom).toContain('№ 720 от 21 апреля 2022 года');
    expect(kor).toContain('1995');
    // Выдумки прежних текстов не возвращаются.
    expect(kor).not.toMatch(/тысячи моржовых туш|другого пути сюда нет/);
    expect(kom).not.toMatch(/Грунтовка|Я стоял/);
  });

  it('отзыв Кузьмича — пустая строка, не NULL: иначе обогатитель напишет новый пересказ', () => {
    for (const id of [KOM, KOR]) {
      const stmt = updatesOf(id).find((s) => /description\s*=/.test(s))!;
      expect(stmt).toMatch(/kuzmich_review = ''/);
    }
  });

  it('source_name влезает в колонку varchar(100)', () => {
    for (const m of BODY.matchAll(/source_name = '((?:[^']|'')*)'/g)) {
      expect(m[1].length, m[1]).toBeLessThanOrEqual(100);
    }
  });
});

describe('координаты: источник и прежняя точка в условии', () => {
  it('Командорские — точка острова Беринга вместо морской, Корякский — участок «Мыс Говена» вместо заглушки', () => {
    const kom = updatesOf(KOM).find((s) => /SET lat/.test(s))!;
    const kor = updatesOf(KOR).find((s) => /SET lat/.test(s))!;
    expect(kom).toMatch(/lat = 55\.0215754, lng = 166\.2712426/);
    expect(kom).toMatch(/54\.9309363/);
    expect(kor).toMatch(/lat = 59\.8865406, lng = 166\.2616559/);
    expect(kor).toMatch(/lat = 60\.0 AND lng = 165\.5/);
    for (const s of [kom, kor]) expect(s).toMatch(/coord_source = 'external'/);
  });
});

describe('разрешение: без мёртвого сайта парка', () => {
  it('komandorsky.ru не стоит ссылкой нигде — ни у места, ни в справочнике парков', () => {
    expect(BODY).not.toMatch(/'https?:\/\/(www\.)?komandorsky\.ru/);
    expect(BODY).toMatch(/eco_permit_url = NULL/);
    expect(BODY).toMatch(/permit_url = NULL/);
  });

  it('у Корякского — заявка на kronoki.ru: им управляет Кроноцкий заповедник', () => {
    const permit = ownPermitOf({ zone: 'federal_reserve', permitUrl: 'https://kronoki.ru/ru/visit/requests/' });
    expect(permit?.label).toBe('Разрешение заповедника');
    expect(updatesOf(KOR).join(';')).toMatch(/eco_permit_url = 'https:\/\/kronoki\.ru\/ru\/visit\/requests\/'/);
  });
});

describe('снимки 1243', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    items: Array<{ key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'(photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];

  it('двенадцать ключей, все залиты media-to-s3 до миграции', () => {
    expect(keys).toHaveLength(12);
    const uploaded = new Set(marker.items.map((i) => i.key));
    for (const k of keys) expect(uploaded.has(k), k).toBe(true);
  });

  it('у каждого снимка автор, свободная лицензия и страница Commons', () => {
    const rows = [...BODY.matchAll(/'(photos\/[a-z0-9/_.-]+\.jpg)'/g)];
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect((BODY.match(/'CC BY-SA [234]\.0'|'Общественное достояние'/g) ?? []).length).toBe(12);
    expect((BODY.match(/'https:\/\/commons\.wikimedia\.org\/wiki\/File:/g) ?? []).length).toBe(12);
  });

  it('чужое фото главным кадром не затирается', () => {
    expect((BODY.match(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)/g) ?? []).length).toBe(2);
  });
});

describe('блок «Экология и охрана природы»', () => {
  it('заповедник описан как режим, а не как Кроноцкий: у Корякского нет чужого рассказа', () => {
    render(<PlaceEco eco={{ zone: 'federal_reserve', permitRequired: true, rules: null, permitUrl: null }} placeName="Корякский заповедник" />);
    expect(screen.getByText('Государственный заповедник')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Кроноцк/);
  });

  it('национальный парк называется национальным парком', () => {
    render(<PlaceEco eco={{ zone: 'national_park', permitRequired: true, rules: null, permitUrl: null }} placeName="Командорские острова" />);
    expect(screen.getByText('Национальный парк')).toBeTruthy();
    expect(document.body.textContent).toMatch(/по разрешению национального парка/);
  });
});

describe('статья «Командорские острова»', () => {
  const SLUG = 'komandorskie-ostrova';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const text = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточкой парка; переходы — по нынешним адресам', () => {
    expect(chronicleForPlace(KOM).map((a) => a.slug)).toContain(SLUG);
    expect((article.links ?? []).map((l) => l.href)).toEqual([
      '/places/komandorskij-gosudarstvennyj-prirodnyj-biosfernyj-zapovednik',
      '/park/komandorskiy',
    ]);
  });

  it('каждая веха — в тексте, годы по порядку; преобразование 2022 года названо', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(text).toContain('№ 720 от 21 апреля 2022 года');
  });

  it('страница: главный кадр с автором и лицензией, лента дат, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Командорские острова');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/komandorskie-ostrova/ostrov-mednyj.jpg');
    const figure = img.closest('figure')!;
    expect(within(figure).getByRole('link', { name: 'SuricataJ' }).getAttribute('href')).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    const dates = screen.getByRole('region', { name: 'Главные даты' });
    expect(within(dates).getAllByRole('listitem')).toHaveLength(article.timeline!.length);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
  });

  it('главный кадр залит в хранилище', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ key: string }>;
    };
    expect(marker.items.map((i) => i.key)).toContain(article.hero!.key);
  });
});
