/**
 * Каркас карточки тура: шапка, липкая колонка, нижняя панель, честные
 * обещания (аудит П6, 24.09).
 *
 * Карточка тура — единственная страница, где платформа продаёт (§11). Аудит
 * нашёл на ней один класс дефектов в разных формах: обещание без источника и
 * место, зарезервированное под то, чего нет.
 *   - нижняя панель держала 60px под таб-бар, которого на странице нет, и
 *     звала «Выбрать дату», когда форма уже была на экране;
 *   - липкая колонка брони была выше окна (1700+ px при 900) — кнопка
 *     «Оставить заявку» пряталась под экраном почти всю прокрутку;
 *   - «оператор отвечает в течение 2 часов», «проверен платформой» и «контур
 *     безопасности» печатались литералами у любого тура (§4.0);
 *   - классы `border-[var(--x)]/40` Tailwind 3 не собирает — вместо оттенка
 *     получалась белая рамка preflight;
 *   - на туре оператора единственным сигналом безопасности было «ВНИМАНИЕ»
 *     с авиакатастрофой и советом туристу самому регистрироваться в МЧС.
 *
 * Решения владельца 24.09: таб-бара на карточке нет (развилка 5), погодный
 * сигнал на турах оператора не выводится, опасности — по activity_type тура
 * (развилка 8).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHazardSignals, getOverallDangerLevel } from '@/lib/safety/hazard-signals';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
/** Код без строк-комментариев: пояснение про старый класс не считается классом. */
const code = (p: string) => read(p)
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .join('\n');

const CARD_PATH = 'app/marketplace/tours/[id]/_TourDetailClient.tsx';
const CARD = code(CARD_PATH);
const WARN = code('components/safety/SafetyWarnings.tsx');
const MSG = code('components/marketplace/MessageOperatorButton.tsx');
const FORM = read('components/marketplace/BookingFormClient.tsx');
const QUERY = read('lib/tours/tour-detail-query.ts');
const ROUTE = code('app/api/safety/warnings/route.ts');

describe('нижняя панель цены (телефон)', () => {
  it('без резерва под таб-бар, которого на карточке нет', () => {
    expect(CARD).not.toMatch(/mb-\[60px\]/);
    expect(CARD).not.toMatch(/<BottomNav\b/);
    expect(CARD).not.toMatch(/\bpb-40\b/);
  });

  it('видна только между карточкой решения и формой', () => {
    expect(CARD).toMatch(/new IntersectionObserver/);
    expect(CARD).toMatch(/ref=\{decisionRef\}/);
    expect(CARD).toMatch(/id="booking" ref=\{bookingRef\}/);
    expect(CARD).toMatch(/const barShown = decisionAbove && !bookingInView/);
    // Скрытая панель не ловит ни пальца, ни Tab.
    expect(CARD).toMatch(/barShown \? 'translate-y-0' : 'translate-y-full pointer-events-none'/);
    expect(CARD).toMatch(/aria-hidden=\{!barShown\}/);
  });
});

describe('липкая колонка брони (десктоп)', () => {
  it('не выше окна: прокручивается сама, кнопка отправки достижима', () => {
    expect(CARD).toMatch(/lg:sticky lg:top-20 lg:max-h-\[calc\(100dvh-6rem\)\] lg:overflow-y-auto/);
  });

  // Приёмка П6: overscroll-contain запирал колесо над колонкой — дойдя до её
  // конца, страница не листалась (замер p6-rev1b.mjs: scrollY стоял на 1800
  // все 30 шагов колеса).
  it('колонка не запирает прокрутку страницы', () => {
    const aside = CARD.slice(CARD.indexOf('<aside'), CARD.indexOf('</aside>'));
    expect(aside).not.toMatch(/overscroll-(contain|none)/);
  });

  // Приёмка П6, «Цена и CTA — в первых 900px»: на 1440×900 цена стояла на
  // y≈605, а первая кнопка (submit) — на y≈1850. Действие — сразу под ценой,
  // выше щита и формы; только lg (на телефоне — карточка решения).
  it('на lg под ценой есть переход к форме — выше щита и календаря', () => {
    const aside = CARD.slice(CARD.indexOf('<aside'), CARD.indexOf('</aside>'));
    const price = aside.indexOf('formatPrice(price)');
    const cta = aside.search(/<a href="#booking" data-testid="aside-cta" className="hidden lg:flex ds-btn ds-btn-primary/);
    const shield = aside.indexOf('Оплата — только после того');
    const form = aside.indexOf('<BookingFormClient');
    expect(price).toBeGreaterThan(0);
    expect(cta, 'в липкой колонке нет действия под ценой').toBeGreaterThan(price);
    expect(cta).toBeLessThan(shield);
    expect(cta).toBeLessThan(form);
  });

  it('фотолента в колонке 8/12 — колонка брони начинается вровень с ней', () => {
    const col = CARD.indexOf('lg:col-span-8');
    const strip = CARD.indexOf('stripPhotos.slice(0, 6)');
    const about = CARD.indexOf('<Eyebrow>О туре</Eyebrow>');
    expect(col).toBeGreaterThan(0);
    expect(strip, 'фотолента снова над сеткой — цена уходит из первого экрана').toBeGreaterThan(col);
    expect(strip).toBeLessThan(about);
  });

  it('щит «оплата после подтверждения» стоит над формой', () => {
    const shield = CARD.indexOf('Оплата — только после того, как оператор подтвердит');
    const form = CARD.indexOf('id="booking"');
    expect(shield).toBeGreaterThan(0);
    expect(shield).toBeLessThan(form);
  });

  it('цены — с выровненными цифрами', () => {
    expect(CARD).toMatch(/fontVariantNumeric: 'lining-nums tabular-nums'/);
    expect(CARD.match(/formatPrice\(price\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(CARD.match(/\.\.\.NUMS \}\}>\{formatPrice\(price\)\}/g)?.length ?? 0).toBe(3);
  });
});

describe('каркас: шапка, крошки, футер', () => {
  it('общая шапка поверх фото, футер на md+', () => {
    expect(CARD).toMatch(/<Header overPhoto \/>/);
    expect(CARD).toMatch(/<div className="hidden md:block">\s*<Footer \/>/);
  });

  it('цвет и зона 44px — на каждой ссылке крошек, а не на <nav>', () => {
    const nav = CARD.slice(CARD.indexOf('aria-label="Хлебные крошки"'), CARD.indexOf('</nav>'));
    const links = nav.match(/<Link\b[^>]*>/g) ?? [];
    expect(links.length).toBe(3);
    for (const l of links) expect(l).toContain('className={CRUMB}');
    const crumb = CARD.match(/const CRUMB = '([^']+)'/)?.[1] ?? '';
    expect(crumb).toMatch(/\btext-white\/85\b/);
    expect(crumb).toMatch(/min-h-\[44px\]/);
  });
});

describe('обещания доверия — только из данных (§4.0)', () => {
  it('«отвечает в течение N часов» не печатается: время ответа не измерено', () => {
    expect(CARD).not.toMatch(/отвечает в течение/);
  });

  it('«проверен платформой» — из partners.is_verified', () => {
    expect(QUERY).toMatch(/p\.is_verified AS operator_verified/);
    expect(CARD).toMatch(/tour\.operator_verified === true && \(/);
    expect(CARD).not.toMatch(/Проводит этот тур сам · проверен платформой/);
  });

  it('«контур безопасности» — только при связи с маршрутом', () => {
    expect(QUERY).toMatch(/ot\.route_id,/);
    expect(CARD).toMatch(/tour\.route_id \? \['Маршрут проходит через контур безопасности платформы'\] : \[\]/);
  });

  it('карточка Кузьмича не обещает погоду в дату: планировщик тура не знает', () => {
    expect(read(CARD_PATH)).not.toMatch(/погод\S* в вашу дату/);
  });
});

describe('«Написать» у гостя — вопрос без регистрации', () => {
  it('на 401 фокус в «Пожеланиях оператору» той же формы, а не логин', () => {
    expect(MSG).toMatch(/GUEST_QUESTION_FIELD_ID = 'booking-requests'/);
    const branch = MSG.slice(MSG.indexOf('res.status === 401'), MSG.indexOf('router.push'));
    expect(branch).toMatch(/getElementById\(GUEST_QUESTION_FIELD_ID\)/);
    expect(branch).toMatch(/\.focus\(/);
    expect(branch).toMatch(/return;/);
    // Поле, на которое ведёт кнопка, существует в единственной форме.
    expect(FORM).toMatch(/id="booking-requests"/);
  });
});

describe('оттенки var()-цветов собираются', () => {
  /** `bg-[var(--x)]/10` — Tailwind 3 такой класс не генерирует вовсе. */
  const BROKEN = /\[var\(--[a-z-]+\)\]\/\d/;
  it.each([
    ['карточка тура', CARD],
    ['SafetyWarnings', WARN],
    ['MessageOperatorButton', MSG],
  ])('%s — без классов opacity на var()', (_name, src) => {
    expect(src).not.toMatch(BROKEN);
  });
});

describe('сигналы безопасности на туре оператора (развилка 8)', () => {
  it('погода с авиакатастрофой и советом про МЧС на туре оператора не выводится', () => {
    for (const activity of ['rafting', 'fishing', 'helicopter', 'boat_trip', undefined]) {
      const s = getHazardSignals({ activity_type: activity, operator_tour: true });
      expect(s.map(x => x.hazard), `activity=${activity}`).not.toContain('weather');
      expect(s.some(x => /авиакатастроф|10 рабочих/i.test(x.message + x.precautions.join(' '))),
        `activity=${activity}`).toBe(false);
    }
  });

  it('на маршруте (не туре оператора) погодный сигнал остаётся', () => {
    expect(getHazardSignals({ activity_type: 'rafting' }).map(x => x.hazard)).toContain('weather');
  });

  it('опасности тура — по его типу активности', () => {
    const hz = getHazardSignals({ activity_type: 'rafting', operator_tour: true }).map(x => x.hazard);
    expect(hz).toEqual(expect.arrayContaining(['rapids', 'water', 'wildlife']));
    expect(getOverallDangerLevel({ activity_type: 'rafting', operator_tour: true })).toBe('warning');
  });

  it('роут: фолбэк на operator_tours.activity_type, флаг тура, бренд «Ведар»', () => {
    expect(ROUTE).toMatch(/COALESCE\(ark\.activity_type, ot\.activity_type\) AS activity_type/);
    expect(ROUTE.match(/operator_tour: operatorTour/g)?.length ?? 0).toBe(2);
    expect(ROUTE, "флаг тура оператора не выводится из tourId — авиакатастрофа вернётся на туры оператора").toMatch(/const operatorTour = Boolean\(tourId\)/);
    expect(ROUTE).not.toMatch(/TourHab/);
    expect(ROUTE).toMatch(/Платформа Ведар/);
  });
});
