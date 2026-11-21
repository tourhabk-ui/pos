import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';
import { FISH_BY_ID } from '@/lib/fish-species';

const code = (p: string) => readFileSync(p, 'utf8');
const BRAND = ' | Ведар';

describe('заголовки под запросы GSC 18–19.11 (Сыщик 21.11)', () => {
  it('места: title с брендом ≤ 60, description ≤ 160, без цен и цифр рублей', () => {
    for (const [slug, m] of Object.entries(PLACE_SEARCH_META)) {
      expect((m.title + BRAND).length, slug).toBeLessThanOrEqual(60);
      expect(m.description.length, slug).toBeLessThanOrEqual(160);
      for (const s of [m.title, m.description]) expect(s, slug).not.toMatch(/₽|руб/);
      if (m.leadAnswer) expect(m.leadAnswer.source.url, slug).toMatch(/^https:\/\//);
    }
  });

  it('Верблюд отвечает, между какими вулканами стоит', () => {
    const m = PLACE_SEARCH_META['ekstruziya-verblyud'];
    expect(m.leadAnswer?.text).toMatch(/между вулканами Авачинский и Корякский/);
  });

  it('карточка места берёт заголовок и ответ из списка, посадочная — сильнее', () => {
    const page = code('app/places/[id]/page.tsx');
    expect(page).toMatch(/landingByPath\(ownPath\)\?\.title \?\? placeSearchMeta\(/);
    expect(page).toMatch(/const leadAnswer = landing \? null : /);
  });

  it('/fish: title под «какая рыба водится на камчатке» ≤ 60 с брендом, описание ≤ 160', () => {
    const src = code('app/fish/page.tsx');
    const title = src.match(/const FISH_INDEX_TITLE = '([^']+)'/)?.[1] ?? '';
    const desc = src.match(/const FISH_INDEX_DESCRIPTION =\s*'([^']+)'/)?.[1] ?? '';
    expect(title).toMatch(/^Какая рыба водится на Камчатке/);
    expect((title + BRAND).length).toBeLessThanOrEqual(60);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).toMatch(/Рыба Камчатки по видам/);
  });

  it('чавыча: прямой ответ с источником', () => {
    const a = FISH_BY_ID.chavycha.leadAnswer;
    expect(a?.text).toMatch(/^Чавыча — самый крупный из тихоокеанских лососей/);
    expect(a?.source.url).toMatch(/^https:\/\/www\.fisheries\.noaa\.gov\//);
  });

  it('/routes: вулканы в title и H1', () => {
    const src = code('app/routes/(list)/page.tsx');
    const title = src.match(/const BASE_METADATA[\s\S]*?title:\s*'([^']+)'/)?.[1] ?? '';
    expect(title).toMatch(/^Маршруты к вулканам Камчатки/);
    expect((title + BRAND).length).toBeLessThanOrEqual(60);
  });
});

describe('/fish: первый абзац отвечает на вопрос', () => {
  it('называет виды, места и сроки, без цен', () => {
    const src = code('app/fish/page.tsx');
    const lead = src.match(/data-lead-answer>([\s\S]*?)<\/p>/)?.[1] ?? '';
    expect(lead).toMatch(/На Камчатке водятся тихоокеанские лососи/);
    expect(lead).toMatch(/Курильское озеро/);
    expect(lead).not.toMatch(/₽|руб/);
    expect(src.indexOf('data-lead-answer')).toBeLessThan(src.indexOf('OfficialSeasonNote />'));
  });
});
