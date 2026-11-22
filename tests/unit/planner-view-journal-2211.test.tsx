// @vitest-environment jsdom
/**
 * Вид плана /planner и PDF (слово владельца 22.11: «предупреждения — кроме
 * них ничего не видно», «дизайн PDF кринж»). Над днями — не стопка плашек:
 * что не вошло — «Этого в плане нет», остальные оговорки — в одном
 * свёрнутом блоке; смета «посчитано X из Y» — в шапке плана; ожидание
 * сборки — честной строкой; кадр тура — только с подписью автора.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWaitLine, dayDateShort, interestsWithoutDay, notInPlanLines, splitPlanShape } from '@/lib/planner/plan-notes';
import { NotInPlan } from '@/components/planner/NotInPlan';
import { PlanOverview } from '@/components/planner/PlanOverview';
import { SafetyBlock } from '@/components/planner/SafetyBlock';
import { DayPhoto } from '@/components/planner/DayPhoto';
import { buildPlanPrintHtml, type PrintPlanInput } from '@/lib/planner/print-html';

afterEach(cleanup);

// Кейс владельца 24.11–04.12 (двое): предупреждения движка как на проде 22.11.
const WEST = 'Рыбалка, снегоходы — Западная зона в план не вошла: на неё нужно 3 дня (день на переезд + 1 день на месте + день на возвращение), а свободных осталось 2.';
const NORTH = 'Северная зона в план не вошла: туров операторов там под вертолётные экскурсии в ваши даты нет, а ехать туда ради дня без тура план не ставит.';
const SEASON = 'Рыбалка, вертолётные экскурсии, снегоходы: по нашему сезонному ориентиру это уже не сезон, но оператор открыл запись на этот месяц.';
const SPAN = '«Камчатка: термальный маршрут» — 5 дн.: тур продают целиком, поэтому под него отданы 5 дн. плана вместо 6 по раскладке.';
const WARNINGS = [
  { type: 'zone_days', severity: 'important', message: WEST },
  { type: 'zone_days', severity: 'important', message: NORTH },
  { type: 'season', severity: 'important', message: SEASON },
  { type: 'duration', severity: 'important', message: SPAN },
  { type: 'safety', severity: 'info', message: 'Территория медведей. Гид с фальшфейером обязателен.' },
];
const DAYS = [
  { day: 1, type: 'arrival', title: 'Прилёт днём. Прогулка по городу', activityType: 'hot_spring' },
  { day: 2, type: 'activity', title: 'Зимняя рыбалка: ноябрь — январь', activityType: 'fishing', realTour: { tourId: '36' } },
  { day: 3, type: 'activity', title: 'Облёт вулканов Мутновский и Горелый', activityType: 'helicopter', realTour: { tourId: '98' } },
  { day: 4, type: 'activity', title: 'Камчатка: термальный маршрут', activityType: 'hot_spring', realTour: { tourId: '112' } },
  { day: 9, type: 'activity', title: 'За снегоходом на Мыс Маячный', activityType: 'snowmobile', realTour: { tourId: '90' } },
];
const label = (id: string) => ({ geyser: 'Гейзеры', bears: 'Медведи', volcano: 'Вулканы' } as Record<string, string>)[id] ?? id;

describe('предупреждения о форме плана делятся на «не вошло» и «о плане»', () => {
  it('зоны, что не вошли, — в «Этого в плане нет»; сезон и длина тура — в свёрнутый блок', () => {
    const { notInPlan, aboutPlan } = splitPlanShape(WARNINGS);
    expect(notInPlan.map((w) => w.message)).toEqual([WEST, NORTH]);
    expect(aboutPlan.map((w) => w.message)).toEqual([SEASON, SPAN]);
  });

  it('интерес без дня — фактом, без выдуманной причины; покрытый названием дня — не попадает', () => {
    const lines = interestsWithoutDay(['volcano', 'geyser', 'fishing'], DAYS, [], label);
    expect(lines).toEqual(['Гейзеры — в плане нет дня с этим. Хотите — добавьте день или напишите оператору в заявке.']);
  });

  it('о чём движок уже сказал — второй раз не пишется', () => {
    const lines = notInPlanLines(WARNINGS, ['fishing', 'snowmobile', 'bears'], DAYS.filter((d) => d.day !== 2 && d.day !== 9), label);
    expect(lines.slice(0, 2)).toEqual([WEST, NORTH]);
    expect(lines.some((l) => l.startsWith('fishing') || l.startsWith('snowmobile'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Медведи'))).toBe(true);
  });

  it('без дней занятий — ничего не придумываем', () => {
    expect(interestsWithoutDay(['geyser'], [{ type: 'arrival', title: 'Прилёт' }], [], label)).toEqual([]);
  });
});

describe('мелочи вида', () => {
  it('дата дня коротко', () => {
    expect(dayDateShort('2026-11-24')).toBe('вт, 24 ноя');
    expect(dayDateShort('2026-12-04')).toBe('пт, 4 дек');
    expect(dayDateShort('')).toBe('');
    expect(dayDateShort('24.11.2026')).toBe('');
  });

  it('ожидание сборки — что делается и сколько идёт, без «за секунды»', () => {
    expect(buildWaitLine(3)).toMatch(/3 с$/);
    expect(buildWaitLine(20)).toMatch(/^Дольше обычного \(20 с\)/);
    expect(buildWaitLine(3) + buildWaitLine(20)).not.toMatch(/секунд[уы]? —|мгновенно|за секунды/);
  });
});

describe('рендер', () => {
  it('«Этого в плане нет» — один спокойный список; пусто — блока нет', () => {
    const { container, rerender } = render(<NotInPlan lines={[WEST, NORTH]} />);
    expect(screen.getByText('Этого в плане нет')).toBeTruthy();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    rerender(<NotInPlan lines={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('шапка плана: «Посчитано X из Y» и итог на виду, «заявка — не бронь»', () => {
    render(<PlanOverview title="11 дней на Камчатке" sub="24 нояб. — 4 дек. · 2 взр." estimateAnchor="plan-estimate" estimate={{
      people: 2,
      lines: [
        { kind: 'tour', label: 'Тур', basis: '55 000 ₽ × 2 чел.', source: 'tour', total: [110000, 110000] },
        { kind: 'lodging', label: 'Проживание', basis: '6 ночей', source: 'open', total: null },
      ],
      total: [110000, 110000], perPerson: [55000, 55000], unpriced: ['Проживание'], assumptions: [],
      fromTours: [110000, 110000], fromOffers: [0, 0],
    } as never} />);
    expect(screen.getByText('Посчитано 1 из 2 позиций')).toBeTruthy();
    expect(screen.getByText(/110\s000 ₽/)).toBeTruthy();
    expect(screen.getByText(/Заявка — не бронь/)).toBeTruthy();
    expect(document.querySelector('a[href="#plan-estimate"]')).toBeTruthy();
  });

  it('оговорки о плане — внутри того же свёрнутого блока безопасности', () => {
    const { container } = render(<SafetyBlock items={[]} planItems={[SEASON, SPAN]} />);
    const details = container.querySelector('details[data-safety-block]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText('О плане')).toBeTruthy();
    expect(screen.getByText('2 пункта')).toBeTruthy();
  });

  it('кадр тура — с подписью автора', () => {
    render(<DayPhoto photo={{ src: '/api/images/x.jpg', caption: 'Фото: Лагуна Экспедиция' }} />);
    expect(screen.getByText('Фото: Лагуна Экспедиция')).toBeTruthy();
  });
});

describe('экран /planner', () => {
  const src = readFileSync(join(process.cwd(), 'app/planner/_PlannerClient.tsx'), 'utf8');
  it('оговорки о плане идут в свёрнутый блок, «не вошло» — в свой список', () => {
    expect(src).toContain('splitPlanShape(recommendation.warnings ?? []).aboutPlan');
    expect(src).toContain('notInPlanLines(recommendation.warnings ?? []');
  });
  it('PDF берёт уже загруженные кадры', () => {
    expect(src).toContain('photos: dayPhotos');
  });
});

describe('PDF: оговорки не стоят над программой, смета не отрывается от заголовка', () => {
  const input: PrintPlanInput = {
    origin: 'https://vedarai.ru',
    dateRange: '2026-11-24 — 2026-12-04', adults: 2, childAges: [],
    days: [{ num: 1, confirmed: false, title: 'Прилёт', badge: 'Прилёт', priceLine: '', description: '', meta: 'Авачинская зона', warnings: [], dayType: 'arrival' }],
    estimate: { people: 2, lines: [{ label: 'Тур', basis: '2 чел.', source: 'tour', total: [1000, 1000] }], total: [1000, 1000], perPerson: [500, 500], assumptions: [] },
    warnings: WARNINGS,
    fmt: (n) => n.toLocaleString('ru-RU'),
  };
  const html = buildPlanPrintHtml(input);
  it('«Этого в плане нет» — после дней, «О плане» — на странице безопасности', () => {
    const program = html.indexOf('<h2>Программа по дням</h2>');
    const firstRow = html.indexOf('class="row');
    const nip = html.indexOf('Этого в плане нет');
    expect(program).toBeGreaterThan(0);
    expect(nip).toBeGreaterThan(firstRow);
    expect(html.slice(program, firstRow)).not.toContain(WEST);
    expect(html.indexOf(SEASON)).toBeGreaterThan(html.indexOf('class="section safety"'));
    expect(html).toContain('<div class="sub">О плане</div>');
  });
  it('заголовок сметы и таблица — в одном неразрывном блоке', () => {
    expect(html).toMatch(/<div class="keep"><h2>Смета на группу[\s\S]*?<\/table><\/div>/);
    expect(html).toContain('.keep { break-inside: avoid;');
  });
});
