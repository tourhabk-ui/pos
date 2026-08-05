/**
 * Точность считается отдельно по стороне отказа.
 *
 * Схема из «Model or Harness?» (Scale AI, arXiv:2607.28802): единица анализа —
 * ребро между двумя компонентами плюс `fault_side`, сторона, подлежащая
 * починке. Их пример: агент сообщает об успешном вызове инструмента, который
 * упал. Обёртка проглотила ошибку — чинить обёртку; обёртка вернула, а модель
 * проигнорировала — чинить модель. Ребро одно, ремонт разный.
 *
 * Почему это понадобилось нам. Точность эволюции была одним числом на все
 * находки и понималась как «врёт ли модель». Но половина находок — про
 * инфраструктуру: сборку, деплой, сеть, наши же сторожа. Их отказы тянули вниз
 * общий порог, из-под которого гаснут КОД-находки: модель получала штраф за то,
 * к чему отношения не имеет, и замолкала.
 *
 * Разбор собственных сбоев 04–05.08 показал, что дороже всего обошёлся ГРЕЙДЕР:
 * проверка деплоя печатала «Status: deploy» как успех (трое суток), потом
 * краснела, не дав сборке начаться, а сторожа спотыкались о собственные
 * комментарии. Ни один из этих случаев не «модель ошиблась».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeEdge,
  edgeSides,
  isConsistent,
  locateFailure,
  COMPONENTS,
} from '@/lib/agents/evo/failure-taxonomy';
import { isModelGuessLocated, applyPublishDecision, decidePublish, MIN_SAMPLE } from '@/lib/agents/evo/precision';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MIGRATION = read('migrations/820_evo_failure_location.sql');
const ROUTE = read('app/api/cron/evo-report/route.ts');
const AGENT = read('lib/agents/evo/growth-agent.ts');

describe('ребро и сторона: форма метки', () => {
  it('ребро каноническое — порядок сторон не создаёт двух групп', () => {
    expect(makeEdge('model', 'harness')).toBe(makeEdge('harness', 'model'));
  });

  it('сторона обязана участвовать в ребре', () => {
    expect(isConsistent({ edge: makeEdge('model', 'harness'), faultSide: 'model' })).toBe(true);
    expect(isConsistent({ edge: makeEdge('model', 'harness'), faultSide: 'grader' })).toBe(false);
  });

  it('неразбираемое ребро не превращается в догадку', () => {
    expect(edgeSides('что-то—непонятное')).toEqual([]);
    expect(edgeSides('model')).toEqual([]);
  });

  it('грейдер есть в словаре — это отдельный класс, а не «обвязка»', () => {
    expect(COMPONENTS).toContain('grader');
    expect(COMPONENTS).toContain('environment');
  });
});

describe('разметка детерминированная', () => {
  it('соврал измеритель — сторона grader', () => {
    const loc = locateFailure({
      category: 'bug',
      title: 'Проверка деплоя печатает статус сборки как успех',
      description: 'Сторож зелёный, хотя контейнер не переключился',
    });
    expect(loc?.faultSide).toBe('grader');
  });

  it('сломалась сборка — сторона environment', () => {
    const loc = locateFailure({ category: 'bug', title: 'Сборка падает на Node 20', description: 'next build, docker' });
    expect(loc?.faultSide).toBe('environment');
  });

  it('разбор ответа провайдера — сторона tool, а не модель', () => {
    // Ответ Anthropic был корректным, терял его наш парсер.
    const loc = locateFailure({ category: 'bug', title: 'Пустой ответ', description: 'разбор ответа: thinking-блок идёт первым' });
    expect(loc?.faultSide).toBe('tool');
  });

  it('галлюцинация — сторона model', () => {
    const loc = locateFailure({ category: 'bug', title: 'Находка ссылается на несуществующий код', description: 'выдуманный вызов' });
    expect(loc?.faultSide).toBe('model');
  });

  it('без совпадений — падаем на категорию, а не выдумываем', () => {
    expect(locateFailure({ category: 'bug', title: 'что-то' })?.faultSide).toBe('model');
    expect(locateFailure({ category: 'security', title: 'что-то' })?.faultSide).toBe('harness');
    expect(locateFailure({ category: 'неизвестная', title: 'что-то' })).toBeNull();
  });

  it('метку ставит код, а не модель', () => {
    // Спрашивать модель, виновата ли модель, — то же, что спрашивать
    // подсудимого о приговоре.
    expect(AGENT).toMatch(/locateFailure\(/);
    expect(AGENT).toMatch(/edge, fault_side/);
  });
});

describe('тормоз смотрит на сторону, а не на категорию', () => {
  it('инфраструктурная находка не считается догадкой модели', () => {
    expect(isModelGuessLocated({ category: 'bug', fault_side: 'grader' })).toBe(false);
    expect(isModelGuessLocated({ category: 'bug', fault_side: 'environment' })).toBe(false);
    expect(isModelGuessLocated({ category: 'bug', fault_side: 'model' })).toBe(true);
  });

  it('неразмеченные записи ведут себя как прежде', () => {
    // Смысл накопленных данных не должен меняться задним числом.
    expect(isModelGuessLocated({ category: 'bug', fault_side: null })).toBe(true);
    expect(isModelGuessLocated({ category: 'security', fault_side: null })).toBe(false);
  });

  it('под тормозом инфраструктурные находки идут, догадки модели ждут', () => {
    const d = decidePublish({ accepted: 0, rejected: MIN_SAMPLE + 2 });
    const out = applyPublishDecision([
      { category: 'bug', severity: 'high', fault_side: 'grader' },      // измеритель — идёт
      { category: 'bug', severity: 'low', fault_side: 'model' },        // догадка — ждёт
      { category: 'bug', severity: 'critical', fault_side: 'model' },   // пробник
    ], d);
    expect(out.map((f) => f.fault_side)).toEqual(['grader', 'model']);
    expect(out.at(-1)?.severity).toBe('critical');
  });
});

describe('метрика в эндпоинте разрезана по месту отказа', () => {
  it('общая точность считает только находки модели', () => {
    expect(ROUTE).toMatch(/fault_side = 'model'/);
    expect(ROUTE).toMatch(/fault_side IS NULL AND category NOT IN/);
  });

  it('есть разрез по ребру и стороне', () => {
    expect(ROUTE).toMatch(/GROUP BY edge, fault_side/);
    expect(ROUTE).toMatch(/precision_by_location/);
  });

  it('разрез считает только опубликованное', () => {
    // Убитое стражем до человека не дошло и в цену ошибки не входит.
    const cut = ROUTE.slice(ROUTE.indexOf('GROUP BY edge, fault_side') - 700, ROUTE.indexOf('GROUP BY edge, fault_side'));
    expect(cut).toMatch(/github_issue_url IS NOT NULL/);
  });
});

describe('миграция 820', () => {
  it('колонки добавляются идемпотентно', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS edge/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS fault_side/);
  });

  it('старые записи остаются NULL — «не размечено» ≠ «виновата модель»', () => {
    expect(MIGRATION).not.toMatch(/UPDATE evo_growth_issues/);
    expect(MIGRATION).not.toMatch(/DEFAULT 'model'/);
  });

  it('есть индекс под разрез по стороне', () => {
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_evo_issues_fault_side/);
  });
});
