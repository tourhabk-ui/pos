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

/** Перепись 19.08 — та, по которой и брались пороги. */
const good = {
  routes_counted: 294,
  navigability: { navigable: 215, orientation_only: 65, not_a_route: 1, not_on_foot: 20 },
  link_kinds: { waypoint: 134, nearby: 447, unknown: 61 },
  link_kind_available: true,
  track_evidence: { recorded: 277, drawn: 22, unclear: 2 },
  cleanup_queues: { no_line: 51, not_on_foot: 20, donor_missing: 8, waypoint_conflict: 7 },
} as unknown as Parameters<typeof judgeCensus>[0];

describe('пороги живут в репозитории, а не в памяти', () => {
  it('значения измерены и названы числами', () => {
    // План Ф6 требует прямо: пороги записаны в репозитории. Порог, который
    // помнит человек, незаметно смягчается.
    expect(CENSUS_BASELINE.navigable).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.waypointLinks).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.recordedTracks).toBeGreaterThan(0);
    expect(CENSUS_BASELINE.cleanupTotal).toBeGreaterThan(0);
  });

  it('допуск задан и не бесконечен', () => {
    expect(TOLERANCE).toBeGreaterThan(0);
    expect(TOLERANCE).toBeLessThanOrEqual(0.25);
  });

  it('перепись 19.08 проходит собственные пороги', () => {
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
    const v = judgeCensus({ ...good, navigability: { ...good.navigability, navigable: 100 } });
    expect(v.red).toBe(true);
    expect(v.findings[0].metric).toMatch(/пригодные/);
  });

  it('просадка на единицы регрессией не считается', () => {
    // Снятый с публикации маршрут — не поломка правила.
    const v = judgeCensus({ ...good, navigability: { ...good.navigability, navigable: 213 } });
    expect(v.red).toBe(false);
  });

  it('у каждой находки названо, что делать', () => {
    // Сигнал без действия читается как шум и через неделю выключается.
    const v = judgeCensus({ ...good, navigability: { ...good.navigability, navigable: 10 },
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
