/**
 * Десктоп-главная «Сводка дня» (решение владельца 30.09: десктоп — по доске
 * «Десктоп — сводка дня» из артефакта; мобильное дерево не трогаем).
 *
 * Сторож держит четыре вещи:
 *  1. источник один с гидами и Кузьмичом — lib/svodka, своего счёта нет;
 *  2. у каждого прибора третий исход (§4.0): «не знаем» не рисуется нулём или
 *     спокойствием, а пустая лента молчащего крона — не «предупреждений нет»;
 *  3. витрина туров — одна выборка fetchPlates, без выдуманных дат и мест;
 *  4. дизайн-система: токены, один h1, стекло только над фото, SOS — в шапке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitAlertTitle, isSafetyTrusted, INGEST_STALE_MS } from '@/lib/home/desk-brief';
import type { Svodka } from '@/lib/svodka/svodka';
import { DESK_ABOUT_HREFS, deskAboutLinks } from '@/components/homepage/desk/DeskAbout';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = read('app/page.tsx');
const DESKTOP = PAGE.slice(PAGE.indexOf('Десктоп-дерево'));
const MOBILE = PAGE.slice(PAGE.indexOf('if (isMobile)'), PAGE.indexOf('Десктоп-дерево'));
const DESK = 'components/homepage/desk';
const FILES = readdirSync(join(process.cwd(), DESK)).filter((f) => f.endsWith('.tsx'));
const BRIEF = code('lib/home/desk-brief.ts');

describe('порядок доски', () => {
  it('сводка → что меняет план и вулканы → можно поехать → помощь', () => {
    const order = ['<DeskHero', '<DeskPlanChanges', '<DeskVolcanoBoard', '<DeskTours', '<DeskHelp', '<DeskAbout'].map((t) => DESKTOP.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('шапка — поверх фото героя', () => {
    expect(DESKTOP).toMatch(/<Header overPhoto \/>/);
  });

  it('мобильное дерево не тронуто: только HomeV8Client', () => {
    expect(MOBILE).toMatch(/<HomeV8Client data=\{homeData\} \/>/);
    expect(MOBILE).not.toMatch(/Desk/);
  });

  it('футер скрыт на телефонных ширинах, BottomNav — в обоих деревьях (#43, #1839)', () => {
    expect(DESKTOP).toMatch(/<div className="hidden md:block">\s*<Footer \/>\s*<\/div>/);
    expect(DESKTOP).toContain('<BottomNav activePath="/" />');
  });
});

describe('источник один с гидами и Кузьмичом', () => {
  it('обстановка, вулканы и погода — loadSvodka, своего запроса нет', () => {
    expect(BRIEF).toMatch(/loadSvodka\(\)/);
    expect(BRIEF).not.toMatch(/volcano_status|open-meteo|COUNT\(\*\)/i);
  });

  it('строки «Что меняет план» — та же лента: типы, дедуп и порядок сайта', () => {
    expect(BRIEF).toMatch(/alert_type = ANY\(\$1::text\[\]\)/);
    expect(BRIEF).toMatch(/\[\.\.\.FEED_ALERT_TYPES\]/);
    expect(BRIEF).toMatch(/DISTINCT ON \(lower\(title\)\)/);
    expect(BRIEF).toMatch(/ORDER BY severity DESC, created_at DESC/);
  });

  it('происхождение — alertOrigin; не узнали — так и сказано', () => {
    expect(BRIEF).toMatch(/alertOrigin\(row\.external_id, row\.source_url\)\?\.label \?\? UNKNOWN_ORIGIN_TEXT/);
  });

  it('отказ ленты — в лог и null, а не пустой список', () => {
    expect(BRIEF).toMatch(/console\.error\('\[home\] лента «Что меняет план» не прочитана'/);
    expect(BRIEF).toMatch(/return null;/);
  });

  it('заголовок делится на место и суть, иначе остаётся целым', () => {
    expect(splitAlertTitle('Халактырский пляж: дорога со стороны Дальнего перекрыта', null))
      .toEqual({ place: 'Халактырский пляж', what: 'дорога со стороны Дальнего перекрыта' });
    expect(splitAlertTitle('Вилючинский перевал — проезд по пропускам', null))
      .toEqual({ place: 'Вилючинский перевал', what: 'проезд по пропускам' });
    expect(splitAlertTitle('Подъём воды на реках юга', null)).toEqual({ place: null, what: 'Подъём воды на реках юга' });
    expect(splitAlertTitle('Штормовое предупреждение', 'Ветер до 25 м/с на побережье'))
      .toEqual({ place: 'Штормовое предупреждение', what: 'Ветер до 25 м/с на побережье' });
  });
});

describe('третий исход (§4.0)', () => {
  const svodka = { safety: { hasAlert: false } } as unknown as Svodka;
  const now = Date.parse('2026-09-30T12:00:00Z');

  it('лента свежая — пустоте верим', () => {
    expect(isSafetyTrusted(svodka, '2026-09-30 10:00:00.12+00', now)).toBe(true);
  });

  it('лента молчит дольше порога, не писала никогда или сводки нет — не верим', () => {
    const old = new Date(now - INGEST_STALE_MS - 60_000).toISOString();
    expect(isSafetyTrusted(svodka, old, now)).toBe(false);
    expect(isSafetyTrusted(svodka, null, now)).toBe(false);
    expect(isSafetyTrusted(null, '2026-09-30 10:00:00+00', now)).toBe(false);
  });

  it('герой: без данных — прочерк и «нет данных», не ноль', () => {
    const hero = code(`${DESK}/DeskHero.tsx`);
    expect(hero).toMatch(/value: vCount == null \? '—'/);
    expect(hero).toMatch(/value: t == null \? '—'/);
    expect(hero).toMatch(/value: feed == null \? '—'/);
    expect(hero).toMatch(/feedRaw === 0 && !brief\.safetyTrusted \? null : feedRaw/);
    expect(hero).toMatch(/vRaw === 0 && !v!\.complete \? null : vRaw/);
  });

  it('лента: пустота молчащего крона — «не знаем», отказ — словами', () => {
    const list = code(`${DESK}/DeskPlanChanges.tsx`);
    expect(list).toMatch(/rows !== null && rows\.length === 0 && !trusted \? null : rows/);
    expect(list).toMatch(/Это не значит, что их нет/);
  });

  it('табло: нет кода — пустой кружок и «нет», а не зелёный', () => {
    const board = code(`${DESK}/DeskVolcanoBoard.tsx`);
    expect(board).toMatch(/if \(!d\) \{[\s\S]{0,300}нет/);
    expect(board).toMatch(/Сводку вулканов сейчас получить не удалось/);
    expect(board).toMatch(/проверены не все источники/);
  });
});

describe('витрина туров', () => {
  it('одна выборка fetchPlates на всё дерево, счётчик — из сводки каталога', () => {
    expect(DESKTOP.match(/fetchPlates\(\)/g)?.length).toBe(1);
    expect(DESKTOP).toMatch(/<DeskTours plates=\{plates\} transfer=\{transfer\} total=\{catalogSummary\?\.total \?\? null\} \/>/);
  });

  it('факты — plateFacts и исход по датам; выдуманных «мест» и «сегодня» нет', () => {
    const t = code(`${DESK}/DeskTours.tsx`);
    expect(t).toMatch(/plateFacts\(p\)/);
    expect(t).toMatch(/AVAILABILITY_LABEL\[p\.availability\]/);
    expect(t).toMatch(/tourPath\(p\)/);
    expect(t).not.toMatch(/мест<|Сегодня,/);
    expect(t).not.toMatch(/FROM operator_tours|pool\.query/);
  });

  it('дверь к заявке /request и «Все туры» → /catalog', () => {
    const t = code(`${DESK}/DeskTours.tsx`);
    expect(t).toMatch(/href="\/request"/);
    expect(t).toMatch(/href="\/catalog"/);
  });
});

describe('дизайн-система', () => {
  it('ровно один h1 на дерево — в герое', () => {
    const h1 = FILES.map((f) => (code(`${DESK}/${f}`).match(/<h1[\s>]/g) ?? []).length).reduce((a, b) => a + b, 0);
    expect(h1).toBe(1);
    expect(code('app/page.tsx')).not.toMatch(/<h1[\s>]/);
  });

  it.each(FILES)('%s: без хардкода hex, font-black, @keyframes и эмодзи', (f) => {
    const src = code(`${DESK}/${f}`);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/font-black|@keyframes/);
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each(FILES)('%s: смысловой текст не токеном-плейсхолдером и не мельче 12px (#125)', (f) => {
    const src = code(`${DESK}/${f}`);
    expect(src).not.toMatch(/text-\[var\(--text-muted\)\]/);
    expect(src).not.toMatch(/text-\[(9|10|11)px\]/);
  });

  it('стекло — только в герое (поверх фото) и на фото карточки тура', () => {
    for (const f of FILES) {
      const src = code(`${DESK}/${f}`);
      if (!/fx-glass/.test(src)) continue;
      expect(['DeskHero.tsx', 'DeskTours.tsx']).toContain(f);
    }
  });

  it('своей SOS-кнопки нет — SOS живёт в шапке (EmergencyAction)', () => {
    for (const f of FILES) expect(code(`${DESK}/${f}`)).not.toMatch(/EmergencyAction|SOSButton|href="\/sos"/);
  });

  it('цены — выравнивающими цифрами (#124)', () => {
    expect(code(`${DESK}/DeskTours.tsx`)).toMatch(/tabular-nums lining-nums text-\[var\(--text-primary\)\]">\{f\.price\}/);
  });
});

describe('о Ведаре и остальные разделы (владелец 30.09)', () => {
  it('каждая ссылка есть в реестре платформы — своих адресов нет', () => {
    expect(deskAboutLinks().map((l) => l.href)).toEqual([...DESK_ABOUT_HREFS]);
  });

  it('ведёт на /about и на полный список /menu', () => {
    const src = code(`${DESK}/DeskAbout.tsx`);
    expect(src).toMatch(/href="\/about"/);
    expect(src).toMatch(/href="\/menu"/);
  });

  it('цифры — счёт платформы; не посчитались — цифр нет', () => {
    expect(DESKTOP).toMatch(/getPlatformCounts\(\)\.catch/);
    expect(DESKTOP).toMatch(/<DeskAbout counts=\{counts\} \/>/);
    const src = code(`${DESK}/DeskAbout.tsx`);
    expect(src).toMatch(/const facts = counts\s*\?/);
    expect(src).not.toMatch(/\b(779|380|294|391)\b/);
  });
});
