/**
 * Ф6 — не дать правилу разъехаться.
 *
 * Перепись считала распределение и печатала его в лог. Решал человек, если
 * посмотрел, — то есть не решал никто. Сторож, зависящий от чужого внимания,
 * не сторож; ровно так восемь суток жила красная #1155.
 *
 * Здесь закрепляется: пороги лежат в репозитории, у каждой находки названо
 * действие, пустой прогон — отказ, а инварианты имеют адрес проверки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  judgeCensus, renderCensusVerdict, CENSUS_BASELINE, CENSUS_INVARIANTS, TOLERANCE,
} from '@/lib/routes/census-verdict';

const WF = readFileSync(join(process.cwd(), '.github/workflows/routes-audit.yml'), 'utf-8');

/**
 * Перепись прода 01.09 — та, по которой перемерены пороги.
 *
 * Прежняя фикстура «19.08» числами прода не была: её вердикты давали в сумме
 * 301 при `routes_counted: 294`, чего живой прогон вернуть не может (черта
 * судит только маршруты с линией). Порог 215 был снят с неё и не
 * воспроизводился ни одним прогоном — разбор в `lib/routes/census-verdict.ts`.
 *
 * Здесь числа сняты пробой с `GET /api/cron/route-data-audit` и внутренне
 * сходятся: 6+262+0+20 = 288 — ровно столько маршрутов с линией.
 */
const good = {
  routes_counted: 392,
  navigability: { navigable: 6, orientation_only: 262, not_a_route: 0, not_on_foot: 20 },
  navigable_ignoring_link_kind: 22,
  trust: {
    states: { navigable: 207, orientation_only: 61, not_on_foot: 20 },
    led_by_evidence: 203,
    line_kind: { recorded_track: 266, sketch: 12, unknown: 10 },
    source_match: { verified: 232, not_checked: 56 },
    donor_binding: { confirmed: 279, proximity_only: 9 },
    freshness: { current: 231, unknown: 57 },
  },
  link_kinds: { waypoint: 240, nearby: 460, unknown: 69 },
  link_kind_available: true,
  track_evidence: { recorded: 266, drawn: 6, unclear: 16 },
  cleanup_queues: { no_line: 51, not_on_foot: 20, donor_missing: 8, waypoint_conflict: 7 },
} as unknown as Parameters<typeof judgeCensus>[0];

describe('пороги живут в репозитории, а не в памяти', () => {
  it('значения измерены и названы числами', () => {
    // План Ф6 требует прямо: пороги записаны в репозитории. Порог, который
    // помнит человек, незаметно смягчается.
    expect(CENSUS_BASELINE.navigable).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.navigableStrict).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.waypointLinks).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.recordedTracks).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.cleanupTotal).toBeGreaterThan(0);
  });

  it('база и факт — одна и та же величина, а не две разных', () => {
    // Порог 215 был снят с решения доверия, а прикладывался к строгому
    // счёту. Такое красное вечно и потому бесполезно. Строгий счёт не может
    // быть больше счёта с исключением: исключение только добавляет права.
    expect(CENSUS_BASELINE.navigableStrict).toBeLessThanOrEqual(CENSUS_BASELINE.navigable);
  });

  it('контрфакт порогом не становится', () => {
    // Он диагностика, а не вердикт: порог по нему сделал бы его вторым
    // правилом (сторож tests/unit/census-counterfactual.test.ts).
    expect(Object.keys(CENSUS_BASELINE)).not.toContain('navigableIgnoringLinkKind');
  });

  it('допуск задан и не бесконечен', () => {
    expect(TOLERANCE).toBeGreaterThan(0);
    expect(TOLERANCE).toBeLessThanOrEqual(0.25);
  });

  it('перепись 01.09 проходит собственные пороги', () => {
    // Порог, рождённый красным, выключают в первую же неделю.
    const v = judgeCensus(good);
    expect(v.red, JSON.stringify(v.findings)).toBe(false);
  });
});

describe('пустая перепись — отказ, а не чистота', () => {
  it('ноль посчитанных маршрутов краснеет и называет причину', () => {
    const v = judgeCensus({ ...good, routes_counted: 0 });
    expect(v.red).toBe(true);
    expect(v.refused).toMatch(/отказ, а не чистота/);
  });

  it('отказ виден в отчёте человеку', () => {
    const md = renderCensusVerdict(judgeCensus({ ...good, routes_counted: 0 }));
    expect(md).toMatch(/Перепись не состоялась/);
  });
});

describe('регрессия ловится и адресуется', () => {
  it('просадка пригодных краснеет', () => {
    // Значение берётся ОТ БАЗЫ, а не пишется числом: база перемеряется, и
    // тест, прибитый к прежнему масштабу, начинал бы проверять не то. Здесь
    // важна черта «упало ниже допустимого», а не конкретная цифра.
    const belowFloor = Math.floor(CENSUS_BASELINE.navigable * 0.5);
    const v = judgeCensus({ ...good, trust: { ...good.trust, states: { ...good.trust.states, navigable: belowFloor } } });
    expect(v.red).toBe(true);
    expect(v.findings[0].metric).toMatch(/пригодные/);
  });

  it('просадка на единицы регрессией не считается', () => {
    // Снятый с публикации маршрут — не поломка правила.
    const v = judgeCensus({ ...good, trust: { ...good.trust, states: { ...good.trust.states, navigable: CENSUS_BASELINE.navigable - 2 } } });
    expect(v.red).toBe(false);
  });

  it('аудит без решения доверия — «не смог», а не «ноль пригодных»', () => {
    // Сборка старее #1288 отдаёт перепись без блока trust. Считать это
    // обвалом права вести значило бы выдать незнание за факт о данных (§4.0),
    // и действие тут другое: смотреть журнал деплоя.
    const { trust: _omit, ...noTrust } = good as typeof good & { trust: unknown };
    const v = judgeCensus(noTrust as typeof good);
    expect(v.red).toBe(true);
    const f = v.findings.find((x) => x.metric.includes('доверия'));
    expect(f, JSON.stringify(v.findings)).toBeTruthy();
    expect(f!.action).toMatch(/деплоя/);
  });

  it('строгий счёт судится своим порогом, а не порогом с исключением', () => {
    // Право вести у 203 из 207 держится на сверке с чужой страницей. Если
    // строгий счёт просядет отдельно, это надо видеть — исключение маскирует.
    const v = judgeCensus({ ...good, navigability: { ...good.navigability, navigable: 0 } });
    expect(v.red).toBe(true);
    expect(v.findings.some((f) => f.metric.includes('без исключения'))).toBe(true);
  });

  it('у каждой находки названо, что делать', () => {
    // Сигнал без действия читается как шум и через неделю выключается.
    const v = judgeCensus({ ...good,
      trust: { ...good.trust, states: { ...good.trust.states, navigable: 10 } },
      navigability: { ...good.navigability, navigable: 0 },
      track_evidence: { recorded: 10, drawn: 0, unclear: 0 } } as typeof good);
    expect(v.findings.length).toBeGreaterThan(0);
    for (const f of v.findings) {
      expect(f.action, `у находки «${f.metric}» нет действия`).toBeTruthy();
      expect(f.action.length).toBeGreaterThan(20);
    }
  });

  it('непришедшая разметка отличается от испорченных данных', () => {
    // Миграция, не применившаяся на проде, — не деградация данных, и действие
    // у неё другое: смотреть журнал деплоя, а не чинить связи.
    const v = judgeCensus({ ...good, link_kind_available: false });
    expect(v.red).toBe(true);
    expect(v.findings.find((f) => f.metric.includes('link_kind'))?.action).toMatch(/деплоя/);
  });

  it('рост очередей уборки краснеет', () => {
    const v = judgeCensus({ ...good, cleanup_queues: { no_line: 300 } } as typeof good);
    expect(v.red).toBe(true);
    expect(v.findings.some((f) => f.metric.includes('очередях'))).toBe(true);
  });
});

describe('инварианты имеют адрес проверки', () => {
  it('названы все пять из плана Ф6', () => {
    expect(CENSUS_INVARIANTS).toHaveLength(5);
  });

  it('у каждого есть живой сторож, а не пожелание', () => {
    // Инвариант без адреса проверки — это пожелание. Переименование сторожа
    // заметят здесь, а не через месяц.
    for (const inv of CENSUS_INVARIANTS) {
      expect(existsSync(join(process.cwd(), inv.guard)), `нет сторожа ${inv.guard} для «${inv.text}»`).toBe(true);
    }
  });
});

describe('судья спрашивает тот эндпоинт, чью форму разбирает', () => {
  /**
   * Регресс 19.08→24.08: судья пристроен к workflow, который уже дёргал
   * /api/cron/routes-audit — другой аудит (total/visible/hidden/merged/
   * categories, lib/routes/audit.ts), без routes_counted и прочих полей
   * GeometryAudit. Каждый прогон честно краснел «посчитала ноль маршрутов»
   * — судья был прав, спрашивали не то. Первый же прогон по расписанию,
   * 24.08, это и показал (issue #1378).
   *
   * /api/cron/route-data-audit — единственный роут, зовущий runGeometryAudit
   * (lib/routes/geometry-audit.ts) и отдающий routes_counted, который судья
   * и читает первым делом.
   */
  it('workflow curl-ит /api/cron/route-data-audit, а не /api/cron/routes-audit', () => {
    const calls = [...WF.matchAll(/\/api\/cron\/([a-z-]+)"/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toBe('route-data-audit');
  });
});

describe('перепись идёт по расписанию и умеет краснеть', () => {
  it('еженедельно, а не только по кнопке', () => {
    // Перепись, которую запускают руками, меряет ровно то, о чём и так
    // вспомнили. Регрессию ловит только регулярная.
    expect(WF).toMatch(/schedule:/);
    expect(WF).toMatch(/cron: '10 4 \* \* 1'/);
  });

  it('прогон вне порогов краснеет', () => {
    expect(WF).toMatch(/Красный, если перепись вышла за пороги/);
    expect(WF).toMatch(/exit 1/);
  });

  it('вердикт выносится в задачу с действием', () => {
    expect(WF).toMatch(/gh issue create|gh issue comment/);
  });

  it('отчёт выходит до падения — иначе теряется сам список цифр', () => {
    const publish = WF.indexOf('Вынести вердикт в задачу');
    const fail = WF.indexOf('Красный, если перепись вышла за пороги');
    expect(publish).toBeGreaterThan(0);
    expect(publish).toBeLessThan(fail);
  });
});
