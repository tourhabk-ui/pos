/**
 * Мобильная карточка тура: цена и путь к заявке — ДО длинного рассказа.
 *
 * Аудит мобильной компоновки (владелец, 27.08): на grid-cols-1 aside с формой
 * был последним блоком — чтобы узнать стоимость, человек листал описание,
 * программу, снаряжение, безопасность, оператора и отзывы. Единственный
 * ранний призыв — глобальная кнопка «Хочу тур» — на ширине меньше sm теряла
 * подпись и вела в БЕЗАДРЕСНУЮ заявку рядом с заявкой на конкретный тур.
 *
 * Контракт (этапы 1-2 плана):
 *  - карточка решения (цена + переход на #booking) стоит в исходнике ВЫШЕ
 *    секции «О туре» и видна только до lg;
 *  - это не вторая форма: переход на единственный #booking, не свой POST;
 *  - контекстная нижняя панель — действие, значит непрозрачная (§5), без
 *    backdrop-blur;
 *  - глобальный StickyLeadButton на детальных страницах тура скрыт, списки
 *    /marketplace и /catalog не задеты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CARD = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');
const FAB = readFileSync(join(ROOT, 'components/shared/StickyLeadButton.tsx'), 'utf-8');

describe('карточка решения на мобильном', () => {
  it('стоит выше секции «О туре» и скрыта на desktop', () => {
    const decision = CARD.indexOf('Выбрать дату и оставить заявку');
    const about = CARD.indexOf('<Eyebrow>О туре</Eyebrow>');
    expect(decision, 'карточка решения не найдена').toBeGreaterThan(0);
    expect(about, 'секция «О туре» не найдена').toBeGreaterThan(0);
    expect(decision, 'цена и CTA должны идти до длинного описания').toBeLessThan(about);

    // До карточки решения — только герой и фотолента; desktop не меняется.
    const head = CARD.slice(0, decision);
    const decisionBlockStart = head.lastIndexOf('lg:hidden');
    expect(decisionBlockStart, 'блок решения обязан быть lg:hidden').toBeGreaterThan(0);
  });

  it('это переход к единственной форме, а не вторая форма', () => {
    // Обе точки входа ведут на один якорь; своего POST /api/bookings в новых
    // блоках нет — форма по-прежнему одна (BookingFormClient в #booking).
    expect(CARD.match(/href="#booking"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(CARD.match(/id="booking"/g)?.length ?? 0).toBe(1);
  });
});

describe('контекстная нижняя панель', () => {
  it('непрозрачная: действие, не контекст (§5)', () => {
    const panelStart = CARD.indexOf('Контекстная нижняя панель');
    expect(panelStart, 'панель не найдена').toBeGreaterThan(0);
    const panel = CARD.slice(panelStart, CARD.indexOf('Выбрать дату\n', panelStart) + 40);
    expect(panel).toContain("background: 'var(--bg-card)'");
    expect(panel).not.toContain('backdrop-blur');
    expect(panel).toContain('safe-area-inset-bottom');
  });
});

describe('глобальная «Хочу тур» уступает контекстному CTA', () => {
  it('скрыта на детальных страницах тура, списки не задеты', () => {
    expect(FAB).toContain("'/marketplace/tours/'");
    expect(FAB).toContain("'/catalog/tours/'");
    // Именно подпути /tours/: сами витрины остаются с кнопкой.
    expect(FAB).not.toContain("'/marketplace',");
    expect(FAB).not.toContain("'/catalog',");
  });
});
