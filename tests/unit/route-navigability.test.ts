/**
 * Черта: что платформа имеет право предлагать как ПУТЬ.
 *
 * Перепись 17.08 по живой базе: 411 маршрутов, 110 без линии вовсе, 154 с
 * линией и без единой путевой точки, 25 с точками, расходящимися с собственной
 * линией, 10 подборок мест. Смоук по проду: пригодных один из пяти.
 * Восемьдесят шесть процентов линий пришли скрейпом с чужого сайта.
 *
 * Решение владельца: провести черту. Для площадки, которая говорит о
 * безопасности туристов, сорок проверенных маршрутов честнее четырёхсот, где
 * каждый пятый ведёт не туда.
 *
 * Черта проходит по ОБЕЩАНИЮ, а не по видимости: описание места остаётся
 * описанием, прятать знание незачем. Нельзя обещать ведение — вот что решается.
 *
 * И решается это в ОДНОМ месте. До сих пор проверок было три: экран выбора сам
 * считал разброс и одиночную точку, паспорт судил род линии, каталог считал
 * «пригодные». Три проверки одного и того же — три правила, и они уже
 * расходились; §12 писался ровно про это.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeNavigability, navigabilityCtaLabel } from '@/lib/routes/navigability';
import { DATA_CONFLICT_KM } from '@/lib/on-route/approach';
import type { LatLng } from '@/lib/routes/track-fidelity';

/** Короткая честная тропа под Петропавловском: полтора километра. */
const TRACK: LatLng[] = Array.from({ length: 30 }, (_, i) => [53.02 + i * 0.0005, 158.65 + i * 0.0005]);
const ON_TRACK = [
  { lat: 53.021, lng: 158.651 },
  { lat: 53.0285, lng: 158.6585 },
];

describe('пригодный маршрут — снятый трек с точками на нём', () => {
  it('вердикт navigable, причин нет', () => {
    const n = routeNavigability({ grade: 'surveyed', track: TRACK, waypoints: ON_TRACK });
    expect(n.verdict).toBe('navigable');
    expect(n.canLead).toBe(true);
    expect(n.reasons).toEqual([]);
  });

  it('его действие обещает ведение', () => {
    expect(navigabilityCtaLabel('navigable')).toMatch(/навигатор/i);
  });
});

describe('длинный маршрут — не подборка', () => {
  /**
   * Прогон по живой базе 17.08 вернул НОЛЬ пригодных из 301 и 92 «маршрутом не
   * являются». Причина была в этом правиле: линию судил `isScatteredCollection`,
   * который объявляет подборкой всё шире 25 км по габариту.
   *
   * У сплошной линии габарит равен длине маршрута. «Сплав по реке Камчатка»
   * (282 км), «Зимник Анавгай — Тигиль» (192) — настоящие пути, и накрывать
   * сотню километров их работа.
   *
   * Урок был записан в переписи геометрии в трёх строках от места правки: она
   * судит линию через `routeIntegrity`, по НЕПРЕРЫВНОСТИ. У сплава шаг между
   * точками метры, у подборки — прыжок в десятки километров.
   *
   * Сторож не поймал этого, потому что проверял подборку только по ТОЧКАМ, с
   * `track: null` — ветка линии не исполнялась ни разу.
   */
  const LONG: LatLng[] = Array.from({ length: 400 }, (_, i) => [53.0 + i * 0.002, 158.6 + i * 0.002]);

  it('сплошная линия в сотню километров остаётся маршрутом', () => {
    const wps = [
      { lat: LONG[10][0], lng: LONG[10][1] },
      { lat: LONG[390][0], lng: LONG[390][1] },
    ];
    const n = routeNavigability({ grade: 'surveyed', track: LONG, waypoints: wps });
    expect(n.verdict).toBe('navigable');
  });

  it('а линия с прыжком в десятки километров — уже нет', () => {
    const broken: LatLng[] = [[53.0, 158.6], [53.01, 158.61], [55.5, 160.9], [55.51, 160.91]];
    const wps = [{ lat: 53.0, lng: 158.6 }, { lat: 55.5, lng: 160.9 }];
    const n = routeNavigability({ grade: 'surveyed', track: broken, waypoints: wps });
    expect(n.verdict).toBe('not_a_route');
  });

  it('правило берётся из общего модуля, своего порога нет', () => {
    const SRC = readFileSync(join(process.cwd(), 'lib/routes/navigability.ts'), 'utf-8');
    // Комментарии вырезаются: прежнее правило в них разобрано намеренно.
    const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(CODE).toMatch(/routeIntegrity\(/);
    // Габаритный признак к сплошной линии неприменим — в коде его быть не должно.
    expect(CODE).not.toMatch(/isScatteredCollection/);
  });
});

describe('обещание ведения даётся только снятому пути', () => {
  it('набросок ведения не обещает', () => {
    const n = routeNavigability({ grade: 'sketch', track: TRACK, waypoints: ON_TRACK });
    expect(n.canLead).toBe(false);
    expect(n.verdict).toBe('orientation_only');
    expect(n.reasons.join(' ')).toMatch(/прямыми между точками/);
  });

  it('линия без записанного происхождения — тоже нет', () => {
    const n = routeNavigability({ grade: 'unknown', track: TRACK, waypoints: ON_TRACK });
    expect(n.canLead).toBe(false);
    expect(n.reasons.join(' ')).toMatch(/происхождение/i);
  });

  it('ориентирование остаётся доступным — знание не прячется', () => {
    expect(navigabilityCtaLabel('orientation_only')).toMatch(/ориентирование/i);
  });
});

describe('линия, которую не с чем сверить, обещания не получает', () => {
  it('снятый трек без путевых точек — только ориентирование', () => {
    // 154 маршрута из переписи. Линия может быть верной, но проверить это
    // платформа не может, а обещание даётся на проверенном.
    const n = routeNavigability({ grade: 'surveyed', track: TRACK, waypoints: [] });
    expect(n.canLead).toBe(false);
    expect(n.reasons.join(' ')).toMatch(/не с чем сверить/);
  });
});

describe('расхождение точек с линией снимает обещание', () => {
  it('точка дальше порога расхождения — не пригоден', () => {
    // «Вулкан Козельский», полевой скрин 17.08: точка в 14 км от трека.
    // Экран выбора этого не видел и предлагал маршрут как обычный.
    const far = [{ lat: 53.02, lng: 158.65 }, { lat: 53.15, lng: 158.65 }];
    const n = routeNavigability({ grade: 'surveyed', track: TRACK, waypoints: far });
    expect(n.canLead).toBe(false);
    expect(n.reasons.join(' ')).toMatch(/не сходятся/);
  });

  it('порог берётся общий с полевым экраном', () => {
    const SRC = readFileSync(join(process.cwd(), 'lib/routes/navigability.ts'), 'utf-8');
    // Свой порог здесь означал бы два разных ответа на один вопрос о данных.
    expect(SRC).toMatch(/DATA_CONFLICT_KM/);
    expect(DATA_CONFLICT_KM).toBeGreaterThan(0);
  });
});

describe('что маршрутом не является — не предлагается вовсе', () => {
  it('подборка мест по краю', () => {
    const scattered = [
      { lat: 53.02, lng: 158.65 },
      { lat: 54.50, lng: 160.20 },
      { lat: 56.10, lng: 161.80 },
    ];
    const n = routeNavigability({ grade: 'points_only', track: null, waypoints: scattered });
    expect(n.verdict).toBe('not_a_route');
    expect(n.canLead).toBe(false);
  });

  it('одна точка — начало и конец совпадают', () => {
    const n = routeNavigability({ grade: 'points_only', track: null, waypoints: [{ lat: 53.02, lng: 158.65 }] });
    expect(n.verdict).toBe('not_a_route');
    expect(n.reasons.join(' ')).toMatch(/одна точка/);
  });

  it('ни линии, ни точек', () => {
    const n = routeNavigability({ grade: 'none', track: null, waypoints: [] });
    expect(n.verdict).toBe('not_a_route');
    expect(n.reasons.join(' ')).toMatch(/вести не по чему/);
  });

  it('у такой записи действия нет вовсе', () => {
    // Предлагать старт по подборке мест значило бы обещать путь, которого нет.
    expect(navigabilityCtaLabel('not_a_route')).toBeNull();
  });
});

describe('отказ всегда назван словами', () => {
  it('непригодный маршрут объясняет причину', () => {
    for (const g of ['sketch', 'unknown', 'points_only'] as const) {
      const n = routeNavigability({ grade: g, track: TRACK, waypoints: ON_TRACK });
      expect(n.reasons.length, `нет причины для ${g}`).toBeGreaterThan(0);
      expect(n.reasons.every(r => r.length > 10)).toBe(true);
    }
  });
});

describe('черта живёт в одном месте, поверхности её спрашивают', () => {
  const API = readFileSync(join(process.cwd(), 'app/api/routes/[id]/route.ts'), 'utf-8');
  const CLIENT = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('вердикт считается на сервере — там есть и линия, и точки', () => {
    // Экран линию не грузит: он видел бы только род данных и не заметил бы
    // расхождения точек с линией.
    expect(API).toMatch(/routeNavigability\(/);
    expect(API).toMatch(/navigability:/);
  });

  it('экран выбора берёт вердикт, а не судит сам', () => {
    expect(CLIENT).toMatch(/navigabilityCtaLabel\(/);
    // Прежняя подпись действия шла от рода линии и не знала о расхождении.
    expect(CLIENT).not.toMatch(/passportCtaLabel\(/);
  });

  it('отсутствие вердикта не превращается в «пригодно»', () => {
    // Старый кэш ответа не имеет поля navigability. Молчание не равно
    // разрешению: экран падает обратно на то, что видит сам.
    expect(CLIENT).toMatch(/\?\? \(previewMap\.scattered \|\| previewMap\.singlePoint \? 'not_a_route' : 'orientation_only'\)/);
  });

  it('причины отказа показываются человеку', () => {
    expect(CLIENT).toMatch(/navigability\.reasons\.map/);
  });
});
