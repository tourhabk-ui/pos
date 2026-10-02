/**
 * Сторож: сводка Минтура доходит до тревог через kamtoday.ru (#2064).
 *
 * kamgov.ru закрыт для нас с обеих сторон (проба 605: раннеру 403). Владелец
 * 26.09 выбрал kamtoday.ru — «Новости Камчатки» пересказывают сводку целиком
 * (пробы 607, 608). Лента общая, поэтому держится и обратное: обычная
 * новость края тревогой не становится.
 *
 * Формулировки пунктов ниже — дословные цитаты сводки из issue #2064.
 * Проверен мутацией: без фильтра isMinturBulletin сторож краснеет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kamtodayArticleText, KAMTODAY_PREFIX } from '@/lib/services/safety/kamtoday';
import { classifyMchsItems, isMinturBulletin } from '@/lib/services/safety/seismic-parser';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { SAFETY_SOURCE_EXPECTATIONS, formatDeadSourceAlert } from '@/lib/services/safety/source-health';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// Разметка как на kamtoday (проба 608): articleBody, <br><br> между пунктами,
// <b> — разделы, &nbsp; и перенос строки внутри пункта.
const ARTICLE = `<html><body><h1>Минтуризма Камчатки</h1>
	<div itemprop="articleBody">


			Министерство туризма Камчатского края опубликовало еженедельную оперативную сводку о&nbsp;доступности туристических объектов.
 <br>
 <br>
 <b>
Природные парки</b>
<br>
 <br>
 В&nbsp;парке «Налычево» летние маршруты открыты. Из-за сохраняющейся паводковой ситуации закрыты автомобильный маршрут «Радыгино — Центральный» и транзитный пеший маршрут.
 <br>
 <br>
 <b>
Вулканы</b>
<br>
 <br>
 На&nbsp;вулкане Безымянный продолжается извержение с&nbsp;выжиманием лавы
 и&nbsp;сходом лавин — посещение не&nbsp;рекомендуется.<br>
 </div>
<div class="share">Поделиться</div></body></html>`;

describe('текст статьи — строками, как их режет разбор сводки', () => {
  const text = kamtodayArticleText(ARTICLE);

  it('пункты — отдельными строками, перенос внутри пункта — пробел, &nbsp; снят', () => {
    expect(text).not.toBeNull();
    const lines = text!.split('\n');
    expect(lines).toContain('На вулкане Безымянный продолжается извержение с выжиманием лавы и сходом лавин — посещение не рекомендуется.');
    expect(lines.some((l) => l.startsWith('В парке «Налычево» летние маршруты открыты.'))).toBe(true);
  });

  it('за пределы articleBody не выходит', () => {
    expect(text).not.toContain('Поделиться');
    expect(text).not.toContain('<');
  });

  it('разметка сменилась — null, а не «сводка пустая»', () => {
    expect(kamtodayArticleText('<html><div class="text">…</div></html>')).toBeNull();
  });

  it('это сводка Минтура по тому же правилу, что у kamgov', () => {
    expect(isMinturBulletin(`Минтуризма Камчатки ${text}`)).toBe(true);
  });
});

describe('сводка становится тревогами источника kamtoday', () => {
  const text = kamtodayArticleText(ARTICLE)!;
  const events = classifyMchsItems(
    `${KAMTODAY_PREFIX}/minturizma`, 'Минтуризма Камчатки: где открыты маршруты', text,
    'Thu, 11 Sep 2026 10:00:00 +1200', 'https://kamtoday.ru/news/poluostrov/minturizma/', KAMTODAY_PREFIX,
  );

  // Тип решает классификатор (тот же, что для kamgov): «сходом лавин» делает
  // пункт лавинным, паводок — паводковым. Здесь держится то, что важно
  // туристу: уровень и зона, по которой тревога ляжет на места.
  const bez = events.find((e) => e.description.includes('Безымянный'));
  const nal = events.find((e) => e.description.includes('Налычево'));

  it('«посещение не рекомендуется» на Безымянном — красный уровень в зоне вулкана', () => {
    expect(bez?.severity).toBe(2);
    expect(bez?.affected_zones).toContain('northern');
  });

  it('закрытый паводком маршрут Налычево — тревога в зоне парка', () => {
    expect(nal?.severity).toBeGreaterThanOrEqual(1);
    expect(nal?.affected_zones).toContain('avachinsky');
  });

  it('тревоги подписаны kamtoday, не министерством', () => {
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.source_id.startsWith('kamtoday/')).toBe(true);
    const o = alertOrigin(events[0].source_id, 'https://kamtoday.ru/news/poluostrov/minturizma/');
    expect(o?.key).toBe('kamtoday');
    expect(o?.label).toContain('пересказ');
  });

  it('недельная сводка живёт неделю и с kamtoday', () => {
    const P = read('lib/services/safety/seismic-parser.ts');
    expect(P).toContain("sourcePrefix === 'kamgov' || sourcePrefix === 'kamtoday' ? 168 : 48");
  });
});

describe('обычная новость ленты тревогой не становится', () => {
  it('статья «про Минтур», но не сводка — сервер её пропускает', () => {
    const K = read('lib/services/safety/kamtoday.ts');
    expect(K).toMatch(/if \(!isMinturBulletin\(`\$\{a\.title\} \$\{text\}`\)\) continue;/);
  });

  it('раннер открывает статьи, где заголовок или анонс называют Минтур или сводку, и только на kamtoday.ru', () => {
    const WF = read('.github/workflows/cron-safety-ingest.yml');
    // 02.10: узкий фильтр «Минтуриз…» только по заголовку мог пропустить
    // выпуск, озаглавленный иначе; анонс (description) RSS тоже читается.
    expect(WF).toContain('const BULLETIN_RE = /минтур|министерств[а-я]* туризма|оперативн[а-я]* сводк|доступност[а-я]* туристическ/i;');
    expect(WF).toContain('BULLETIN_RE.test(i.title + " " + i.description)');
    expect(WF).toContain('description: tag(b, "description")');
    expect(WF).toContain('matched.slice(0, 3)');
  });
});

describe('связка раннер → прод → здоровье источника', () => {
  const WF = read('.github/workflows/cron-safety-ingest.yml');
  const ROUTE = read('app/api/cron/safety-ingest/route.ts');

  it('раннер шлёт статьи и то, что видел в ленте', () => {
    expect(WF).toContain('{kamtoday_articles: $kamtoday_articles[0]}');
    expect(WF).toContain('{kamtoday_fetch: $kamtoday_fetch[0]}');
    // Упавший разбор ленты не роняет приём сейсмики и МЧС.
    expect(WF).toContain('|| echo "kamtoday: разбор ленты упал');
  });

  it('прод разбирает статьи и пишет здоровье kamtoday двумя ключами, только если раннер ходил', () => {
    expect(ROUTE).toContain('ingestKamtodayArticles(parsed.data.kamtoday_articles ?? [], kamtodayFetch)');
    // 02.10: лента и сводка — два вопроса. Лента жива постами; сводка —
    // статьями, прошедшими isMinturBulletin (rawItems = bulletins).
    expect(ROUTE).toMatch(/\.\.\.\(kamtodayFetch && kamtodayResult\s*\? \[\s*entryFor\('kamtoday', '[^']+', kamtodayResult\),\s*entryFor\('kamtoday_bulletin', '[^']+', \{\s*\.\.\.kamtodayResult, rawItems: kamtodayResult\.bulletins,/);
  });

  it('сводка считается, даже если тревог из неё не вышло', () => {
    const K = read('lib/services/safety/kamtoday.ts');
    expect(K).toMatch(/if \(!isMinturBulletin\([^)]*\)\) continue;\s*(?:\/\/[^\n]*\n\s*)*result\.bulletins\+\+;/);
    expect(K).toContain('export type KamtodayParseResult = ParseResult & { bulletins: number }');
  });

  it('лента жива постами, сводка — выпусками: два ключа, два срока, свои объяснения', () => {
    const kt = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'kamtoday');
    expect(kt?.maxSilenceHours).toBe(48);
    expect(kt?.aliveBy).toBe('raw_items');
    expect(kt?.deadHint).toBeTruthy();
    expect(kt?.knownDormant).toBeUndefined();
    const kb = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'kamtoday_bulletin');
    expect(kb?.maxSilenceHours).toBe(240);
    expect(kb?.aliveBy).toBe('raw_items');
    expect(kb?.deadHint).toMatch(/сводки/);
    // Общая фраза «парс сломан?» про еженедельную сводку — ложь (02.10).
    expect(formatDeadSourceAlert([{ key: 'kamtoday_bulletin', label: kb!.label, reason: 'never', silentHours: null, hint: kb!.deadHint }]))
      .not.toContain('парс сломан');
    const kg = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'kamgov');
    expect(kg?.knownDormant?.reason).toContain('решение владельца 26.09');
    expect(kg?.knownDormant?.reason).toContain('kamtoday.ru');
  });
});
