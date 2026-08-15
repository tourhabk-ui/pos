/**
 * «Подготовка к походу» (план FCN, этап 4): детерминированный план, а не
 * мнение модели.
 *
 * Инварианты:
 *  - «обязательно по мнению AI» не существует: required с источником
 *    ai_suggestion не проходит ни через движок, ни через CHECK в БД;
 *  - у каждого item есть reason и source — «так надо» не бывает;
 *  - состояние полевого пакета — факт манифеста: кликом «готово» его не
 *    сделать готовым;
 *  - «N из 7 доменов подготовлены» — статус подготовки, не разрешение:
 *    слово «подготовлены», никакого «готов к выходу»;
 *  - доменная модель одна — lib/preparation, второй движок подготовки
 *    не заводится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeItem, buildPreparationItems, summarizeDomains, nextActions,
  type PrepEngineInput,
} from '@/lib/preparation/engine';
import { PREP_DOMAINS, type PrepItem } from '@/lib/preparation/types';
import type { RoutePassport } from '@/lib/routes/passport';
import type { PackAssetState } from '@/lib/offline/field-pack';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const PASSPORT: RoutePassport = {
  grade: 'surveyed',
  source: 'idilesom',
  version: 2,
  waypointsCount: 7,
  verifiedAt: null,
  updatedAt: null,
  access: { mchsRequired: true, mchsPhone: '112', parkName: 'Налычево', parkApprovalUrl: null },
  officialPassportUrl: null,
};

const PACK_READY: PackAssetState[] = [
  { kind: 'waypoints', status: 'ready', note: '7 точек' },
  { kind: 'route', status: 'ready', note: 'Линия сохранена' },
  { kind: 'tiles', status: 'ready', note: 'Карта сохранена' },
  { kind: 'safety_snapshot', status: 'ready', note: 'Условия: 10 мин назад' },
];

function input(over: Partial<PrepEngineInput> = {}): PrepEngineInput {
  return {
    passport: PASSPORT,
    packStates: null,
    answers: {},
    conditionsAgeMs: null,
    userStates: {},
    ...over,
  };
}

describe('обязательность — только из проверяемого источника', () => {
  it('makeItem понижает required от AI до recommended', () => {
    const item = makeItem({
      code: 'x', domain: 'route', importance: 'required', state: 'needs_action',
      title: 'т', reason: 'п',
      source: { type: 'ai_suggestion' },
    } as PrepItem);
    expect(item.importance).toBe('recommended');
  });

  it('в полном плане нет required с источником ai_suggestion', () => {
    const items = buildPreparationItems(input({
      answers: { duration: 'multi_day', party: 'group', experience: 'first_time' },
      packStates: PACK_READY,
    }));
    for (const i of items.filter(x => x.importance === 'required')) {
      expect(i.source.type).not.toBe('ai_suggestion');
    }
  });

  it('у каждого item есть reason и source', () => {
    const items = buildPreparationItems(input({ answers: { duration: 'overnight', party: 'group' } }));
    for (const i of items) {
      expect(i.reason.length).toBeGreaterThan(0);
      expect(i.source.type.length).toBeGreaterThan(0);
    }
  });

  it('CHECK в миграции дублирует стража на уровне данных', () => {
    const mig = read('migrations/864_trip_preparation.sql');
    expect(mig).toMatch(/CHECK \(NOT \(importance = 'required' AND source_type = 'ai_suggestion'\)\)/);
    expect(mig).toMatch(/IF NOT EXISTS/);
  });
});

describe('правила детерминированы и отвечают на сценарий', () => {
  it('МЧС-регистрация появляется только когда маршрут её требует', () => {
    const withMchs = buildPreparationItems(input());
    expect(withMchs.find(i => i.code === 'mchs_registration')?.importance).toBe('required');
    const without = buildPreparationItems(input({
      passport: { ...PASSPORT, access: { ...PASSPORT.access, mchsRequired: false } },
    }));
    expect(without.find(i => i.code === 'mchs_registration')).toBeUndefined();
  });

  it('ночёвка добавляет укрытие как required от выбора человека', () => {
    const items = buildPreparationItems(input({ answers: { duration: 'overnight' } }));
    const shelter = items.find(i => i.code === 'shelter');
    expect(shelter?.importance).toBe('required');
    expect(shelter?.source.type).toBe('user_input');
    expect(buildPreparationItems(input({ answers: { duration: 'day' } }))
      .find(i => i.code === 'shelter')).toBeUndefined();
  });

  it('группа добавляет роли; одиночке их не навязывают', () => {
    expect(buildPreparationItems(input({ answers: { party: 'group' } }))
      .find(i => i.code === 'group_roles')).toBeDefined();
    expect(buildPreparationItems(input({ answers: { party: 'solo' } }))
      .find(i => i.code === 'group_roles')).toBeUndefined();
  });
});

describe('полевой пакет — факт, не клик', () => {
  it('готовый манифест делает item ready', () => {
    const items = buildPreparationItems(input({ packStates: PACK_READY }));
    expect(items.find(i => i.code === 'field_pack')?.state).toBe('ready');
  });

  it('клик «готово» не перекрывает отсутствие пакета', () => {
    const items = buildPreparationItems(input({
      packStates: null,
      userStates: { field_pack: 'ready' },
    }));
    expect(items.find(i => i.code === 'field_pack')?.state).toBe('needs_action');
  });
});

describe('сводка и следующие действия', () => {
  it('доменов всегда семь', () => {
    const domains = summarizeDomains(buildPreparationItems(input()));
    expect(domains.map(d => d.domain)).toEqual(PREP_DOMAINS);
  });

  it('recommended не мешает домену считаться подготовленным', () => {
    const items = buildPreparationItems(input({ packStates: PACK_READY }));
    const nav = summarizeDomains(items).find(d => d.domain === 'navigation');
    // field_pack ready; power_bank (recommended, unknown) не блокирует.
    expect(nav?.prepared).toBe(true);
  });

  it('«нужно решить» — максимум 4, required первыми, без recommended', () => {
    const actions = nextActions(buildPreparationItems(input({
      answers: { duration: 'multi_day', party: 'group' },
    })));
    expect(actions.length).toBeLessThanOrEqual(4);
    expect(actions.every(a => a.importance !== 'recommended')).toBe(true);
    const firstCheck = actions.findIndex(a => a.importance === 'check');
    const lastRequired = actions.map(a => a.importance).lastIndexOf('required');
    if (firstCheck !== -1 && lastRequired !== -1) {
      expect(lastRequired).toBeLessThan(firstCheck);
    }
  });
});

describe('экран говorит статус, а не даёт разрешение', () => {
  const screen = read('app/routes/[id]/prepare/_PrepareClient.tssx'.replace('.tssx', '.tsx'));

  it('слово всегда «подготовлены», не «готов к выходу»', () => {
    expect(screen).toContain('доменов подготовлены');
    const code = screen.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/готов к выходу|можно идти|безопасно/i);
  });

  it('экран строит план движком, а не своими правилами', () => {
    expect(screen).toMatch(/buildPreparationItems/);
    expect(screen).toMatch(/summarizeDomains/);
    expect(screen).toMatch(/nextActions/);
  });

  it('карточки действий плотные, контекст — стекло (контракт владельца)', () => {
    expect(screen).toMatch(/fx-glass-dense/);
    expect(screen).toMatch(/fx-glass/);
    const css = read('app/globals.css');
    expect(css).toMatch(/prefers-reduced-transparency/);
  });

  it('входы ведут в один экран: карточка маршрута и планировщик', () => {
    expect(read('app/routes/[id]/_RouteDetailClient.tsx')).toMatch(/\/prepare/);
    expect(read('app/planning/_PlanningClient.tsx')).toMatch(/\/prepare/);
  });

  it('доменная модель одна — lib/preparation', () => {
    expect(screen).toMatch(/@\/lib\/preparation/);
  });
});
