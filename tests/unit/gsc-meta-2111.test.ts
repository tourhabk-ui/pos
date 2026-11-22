import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';
import { FISH_BY_ID } from '@/lib/fish-species';
import { FISH_LEAD, FISH_PAGE_DESCRIPTION, FISH_PAGE_TITLE } from '@/lib/seo/fish-page';

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

  it('/fish: title под «рыбалка на Камчатке» ≤ 60 с брендом, описание ≤ 160', () => {
    expect(FISH_PAGE_TITLE).toMatch(/^Рыбалка на Камчатке/);
    expect((FISH_PAGE_TITLE + BRAND).length).toBeLessThanOrEqual(60);
    expect(FISH_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/путёвк/);
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
  it('сразу говорит, что рыбалка возможна, называет виды и путёвку, без цен', () => {
    expect(FISH_LEAD).toMatch(/^Рыбалка на Камчатке возможна/);
    expect(FISH_LEAD).toMatch(/лосос/);
    expect(FISH_LEAD).toMatch(/путёвк/);
    expect(FISH_LEAD).toMatch(/палтус/);
    expect(FISH_LEAD).toMatch(/навагу/);
    expect(FISH_LEAD).not.toMatch(/₽|руб/);
    const src = code('app/fish/page.tsx');
    const body = src.slice(src.indexOf('export default async function'));
    expect(body).toContain('FishIndexIntro');
    expect(body.indexOf('FishIndexIntro')).toBeLessThan(body.indexOf('OfficialSeasonNote'));
  });
});
