/**
 * Бюджет ширины шапки главной и зона нажатия иконок (#893).
 *
 * Дефект: `.v7 .icn` объявлял `width:44px;height:44px`, но у флекс-ребёнка
 * работает дефолтный `flex-shrink:1` — и в тесной шапке ФАКТИЧЕСКАЯ зона
 * нажатия сжималась до 19–37px при формально правильном CSS. Существующий
 * сторож `home-hitboxes.test.ts` этого не видел: он читает объявленную высоту,
 * а здесь ломал layout, а не декларация.
 *
 * Почему этот сторож всё-таки текстовый, а не браузерный. Регуляркой сжатие не
 * поймать — нужен layout. Но `flex:none` закрывает слепое пятно ПО ПОСТРОЕНИЮ:
 * если сжатие запрещено, измерять нечего. Поэтому сторож следит не за
 * пикселями, а за наличием того, что делает пиксели невозможными.
 *
 * Измерение (его нельзя заменить тестом) — `scripts/measure-header-budget.mjs`.
 * Бюджет на 2026-07-30, реальный Manrope: бренд 76.36 + пилюля 165.47 (худший
 * текст) + SOS 74.84 + иконки 88 + зазоры 60 = 464.67px против доступных
 * 320/350/372 при 360/390/412. Шапка перегружена на любой мобильной ширине,
 * поэтому одного `flex:none` недостаточно — он возвращал переполнение #892
 * в 5 сочетаниях из 9.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const ACTION = readFileSync(join(process.cwd(), 'components/shared/EmergencyAction.tsx'), 'utf-8');

/** Тело правила по точному селектору. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc}\\{([^{}]*)\\}`).exec(SRC)?.[1] ?? '';
}

describe('зона нажатия иконок шапки не сжимается', () => {
  it('.icn объявляет flex:none — иначе 44px остаются только на бумаге', () => {
    const icn = rule('.v7 .icn');
    expect(icn, 'не разобрать правило .icn').not.toBe('');
    expect(icn, 'без flex:none flex-shrink съедает зону нажатия (#893)').toMatch(/flex:\s*none/);
    expect(icn).toMatch(/width:\s*44px/);
    expect(icn).toMatch(/height:\s*44px/);
  });

  it('глиф внутри остаётся мелким — компактность не за счёт зоны', () => {
    expect(rule('.v7 .icn .li')).toMatch(/width:\s*19px/);
  });
});

describe('шапка не может переполниться по горизонтали', () => {
  it('полоса шапки переносит строку вместо ухода за экран', () => {
    // Переполнение прячет доступное действие (P1 из #892 — обрезанная кнопка).
    // Вторая строка честнее: всё видно, просто ниже.
    const bar = rule('.v7 .topbar .in');
    expect(bar, 'не разобрать правило полосы шапки').not.toBe('');
    expect(bar, 'без flex-wrap запрет сжатия возвращает переполнение').toMatch(/flex-wrap:\s*wrap/);
  });

  it('бренд уходит на узких ширинах — он единственный уступает', () => {
    // Порог выведен из бюджета (см. заголовок файла), а не выбран круглым:
    // с брендом состояние «Опасность» требует 399.01px, то есть viewport 440+.
    const mq = /@media \(max-width:(\d+)px\)\{\.v7 \.topbar \.brand\{display:none\}\}/.exec(SRC);
    expect(mq, 'бренд больше не скрывается на узких — бюджет не сойдётся').toBeTruthy();
    const threshold = Number(mq![1]);
    expect(threshold, 'порог ниже 412px оставит частую ширину двухстрочной')
      .toBeGreaterThanOrEqual(412);
  });
});

describe('то, что уступать нельзя, осталось на месте', () => {
  it('пилюля по-прежнему не сжимается и не обрезается (833120d)', () => {
    // Обрезанная «Опасность» скрывала активный алерт severity 2+ на проде.
    // Освобождать ширину за счёт статуса безопасности запрещено.
    const pill = rule('.v7 .pill');
    expect(pill).toMatch(/flex:\s*none/);
    expect(pill, 'обрезка статуса безопасности вернулась').not.toContain('text-overflow');
  });

  it('SOS держит собственный минимум 44px', () => {
    expect(ACTION).toMatch(/minWidth:\s*['"]44px['"]/);
    expect(ACTION).toMatch(/minHeight:\s*['"]44px['"]/);
  });

  it('профиль остаётся в шапке — в нижней навигации его нет', () => {
    // CLAUDE.md: ЛК только в шапке. Освобождать ширину, убрав профиль,
    // значило бы убрать единственный вход в личный кабинет.
    const nav = readFileSync(join(process.cwd(), 'components/shared/BottomNav.tsx'), 'utf-8');
    expect(nav, 'профиль появился в BottomNav — пересмотреть бюджет шапки')
      .not.toMatch(/\/profile/);
    expect(SRC).toMatch(/href="\/profile"[\s\S]{0,80}className="icn"|className="icn"[\s\S]{0,80}\/profile/);
  });
});
