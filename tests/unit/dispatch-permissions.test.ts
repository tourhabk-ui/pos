/**
 * Сторож матрицы прав в PlatformAgent.
 *
 * Находка аудита 08.09, подтверждённая уликой: `canDispatchIntent` был
 * написан в `permissions.ts`, но в `platform-agent.ts` не вызывался НИ РАЗУ.
 *
 * Ключевой классификатор роль учитывает сам, а ветка `classifyWithAI` — нет:
 * её единственная проверка это `VALID_INTENTS.includes(cleaned)`, то есть
 * «такой интент вообще бывает», а не «этой роли он положен». Стоило модели
 * вернуть туристу `rescue_sos_stats` — и маршрутизатор шёл в RescueAgency с
 * `FROM sos_events`; на `channel_post_route` — публиковал в канал.
 *
 * Правило простое и держится здесь: согласие модели с инструкцией о роли —
 * не проверка прав. Проверка обязана быть детерминированной и стоять между
 * классификацией и маршрутизацией.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  canDispatchIntent, allowedIntentsForRole, ADMIN_ONLY_INTENTS, NON_ADMIN_ROLES,
} from '../../lib/agents/permissions';

const AGENT = readFileSync('lib/agents/platform-agent.ts', 'utf8');

describe('матрица прав действительно спрашивается', () => {
  it('platform-agent импортирует и зовёт canDispatchIntent', () => {
    expect(AGENT).toContain("from '@/lib/agents/permissions'");
    expect(AGENT).toMatch(/canDispatchIntent\(params\.role, intent\)/);
  });

  it('проверка стоит МЕЖДУ классификацией и маршрутизацией', () => {
    const ai = AGENT.indexOf('await this.classifyWithAI(');
    const gate = AGENT.indexOf('canDispatchIntent(params.role, intent)');
    const route = AGENT.indexOf('await this.route(intent,');
    expect(ai).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(ai);
    expect(route).toBeGreaterThan(gate);
  });

  it('непозволенный интент гасится в unknown, а не исполняется', () => {
    const gate = AGENT.slice(AGENT.indexOf('canDispatchIntent(params.role, intent)'));
    expect(gate.slice(0, 500)).toContain("intent = 'unknown';");
  });

  it('отказ пишется в лог поимённо: в ответе его не видно', () => {
    expect(AGENT).toContain('[platform-agent] интент не положен роли');
    expect(AGENT).toMatch(/role: params\.role \?\? 'anonymous'/);
  });

  it('одной проверки VALID_INTENTS недостаточно — она про существование, не про права', () => {
    // Строка остаётся на месте (она нужна), но одна собой матрицу не заменяет.
    expect(AGENT).toContain('VALID_INTENTS.includes(cleaned)');
    expect(AGENT).toMatch(/canDispatchIntent/);
  });
});

describe('сама матрица: кому что положено', () => {
  it('туристу закрыты сводка SOS и публикация в канал', () => {
    expect(canDispatchIntent('tourist', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent('tourist', 'channel_post_route')).toBe(false);
    expect(canDispatchIntent('tourist', 'op_revenue')).toBe(false);
  });

  it('аноним не может ничего', () => {
    expect(allowedIntentsForRole('anonymous')).toEqual([]);
    expect(canDispatchIntent('anonymous', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent(null, 'tourist_recommend')).toBe(false);
  });

  it('роль неизвестного вида прав не получает', () => {
    // Пустой список для незнакомой роли, а не «раз не знаем — пускаем».
    expect(canDispatchIntent('superuser', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent(undefined, 'op_revenue')).toBe(false);
  });

  it('гиду сводка SOS положена, оператору — свои интенты', () => {
    expect(canDispatchIntent('guide', 'rescue_sos_stats')).toBe(true);
    expect(canDispatchIntent('operator', 'op_revenue')).toBe(true);
    expect(canDispatchIntent('operator', 'rescue_sos_stats')).toBe(false);
  });

  it('админу открыто всё', () => {
    expect(canDispatchIntent('admin', 'rescue_sos_stats')).toBe(true);
    expect(canDispatchIntent('admin', 'channel_post_route')).toBe(true);
  });
});


/**
 * Мёртвая ветка маршрутизатора — находка аудита 08.09, и она о ЦЕНЕ
 * предыдущей починки.
 *
 * Гейт `canDispatchIntent` поставили накануне. До того он не вызывался ни
 * разу, матрица была украшением, и никто не замечал, что она никогда не
 * сверялась с `route()`. Стоило гейту заработать — и стало видно: из
 * двадцати двух веток маршрутизатора двенадцать недостижимы никому, кроме
 * админа со звёздочкой, и пять из них — своё агентство гида, включая
 * `guide_route_preflight`, проверку маршрута перед выходом.
 *
 * Живой аварии не случилось: `dispatch` сегодня зовут только с ролями
 * `admin` и `operator`, а функции гида живут обычными роутами мимо агента.
 * Но скрытое расхождение стало закреплённым, и следующий, кто заведёт путь
 * гида, получил бы тихий `unknown` вместо ответа.
 *
 * Отсюда правило: ветка, которую маршрутизатор умеет обрабатывать, обязана
 * быть достижима хоть кем-то, кроме админа, — либо ЯВНО объявлена админской.
 * Состояния «просто забыли» тут быть не должно.
 */
describe('мёртвых веток маршрутизатора нет', () => {
  const ROUTED = [...AGENT.matchAll(/^\s*case '([a-z_]+)':/gm)]
    .map((m) => m[1])
    .filter((i) => i !== 'unknown');

  it('ветки вообще нашлись — сторожу есть что сторожить', () => {
    expect(ROUTED.length).toBeGreaterThan(15);
  });

  it('у каждой ветки есть роль, которая до неё доходит', () => {
    const orphan = ROUTED.filter(
      (intent) =>
        !ADMIN_ONLY_INTENTS.includes(intent) &&
        !NON_ADMIN_ROLES.some((r) => canDispatchIntent(r, intent)),
    );
    expect(
      orphan,
      `маршрутизатор их обрабатывает, но позвать не может никто: ${orphan.join(', ')}`,
    ).toEqual([]);
  });

  it('админские по замыслу названы явно, а не молчанием', () => {
    // Список существует затем, чтобы «решили не давать» не сливалось с
    // «забыли дать»: молчание этих двух вещей не различает.
    for (const intent of ADMIN_ONLY_INTENTS) {
      expect(
        NON_ADMIN_ROLES.some((r) => canDispatchIntent(r, intent)),
        `${intent} объявлен админским, но выдан роли`,
      ).toBe(false);
    }
  });

  it('предполётная проверка маршрута доступна гиду', () => {
    // Ради неё платформа и существует: гид смотрит маршрут перед выходом.
    expect(canDispatchIntent('guide', 'guide_route_preflight')).toBe(true);
    expect(canDispatchIntent('guide', 'guide_status')).toBe(true);
  });

  it('расширение матрицы не открыло чужого', () => {
    expect(canDispatchIntent('guide', 'op_revenue')).toBe(false);
    expect(canDispatchIntent('tourist', 'guide_route_preflight')).toBe(false);
    expect(canDispatchIntent('anonymous', 'guide_route_preflight')).toBe(false);
    expect(canDispatchIntent('guide', 'channel_post_route')).toBe(false);
  });
});
