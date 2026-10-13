/**
 * Сторож: реестр гейтов кабинета оператора (CRM фаза 2г, решение владельца
 * 11.10 — менеджеру всё, кроме денег и настроек; цены и отмена броней —
 * правами, которые даёт владелец кабинета).
 *
 * Каждый роут, в который ходит кабинет оператора, объявлен здесь одним
 * исходом, и объявление сверяется с кодом:
 *   owner  — деньги и настройки: каждый обработчик зовёт requireOperatorOwner
 *            или requirePartnerOwner;
 *   team   — владелец и менеджер: кабинет находит общий резолвер, своего
 *            поиска по partners.user_id нет. Права менеджера (perms),
 *            действия только владельцу (ownerOnly) и вынутые на сервере
 *            деньги (moneyHidden) объявляются и сверяются в обе стороны;
 *   user   — данные самого аккаунта, кабинет не ищется вовсе;
 *   legacy — ищет кабинет по user_id владельца: менеджеру ЗАКРЫТО, а не
 *            открыто. Причина с шагом плана обязательна; переведённый на
 *            общий резолвер роут краснеет, пока запись не снята;
 *   public — без входа.
 *
 * Роут без объявления — красный: новый экран денег, заведённый «как все»,
 * открылся бы менеджеру молча. Деньги и настройки по пути (MONEY_RE) не
 * бывают team. Связка с экранами: каждый адрес /api/, который зовёт кабинет
 * (app/hub/operator, components/operator), обязан быть в реестре или в
 * HELD_ELSEWHERE с названным сторожем.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CABINET_DIRS, GATES, HELD_ELSEWHERE, MONEY_RE, OWNER_GATE, TEAM_RESOLVER, INLINE_OWNER_LOOKUP, OWNER_ACTION,
  MONEY_HIDDEN, AUTH_CALL, ROOT, apiUrlsIn, code, handlerReaches, handlers, helpers, permsInCode, read,
  resolveRoute, routeFiles, sourceFiles, withAliases,
} from '../helpers/operator-gates';

describe('реестр гейтов кабинета оператора', () => {
  it('каждый роут кабинета объявлен, и каждое объявление указывает на живой файл', () => {
    const files = CABINET_DIRS.flatMap(routeFiles);
    expect(files.length).toBeGreaterThan(40);
    const undeclared = files.filter(f => !(f in GATES));
    expect(undeclared, 'роут кабинета без объявления: владелец, команда, право, аккаунт или старый поиск?').toEqual([]);
    const stale = Object.keys(GATES).filter(f => !existsSync(join(ROOT, f)));
    expect(stale, 'объявление без файла — снимите запись').toEqual([]);
  });

  it('деньги и настройки по адресу — не командные роуты', () => {
    const open = Object.entries(GATES)
      .filter(([f, g]) => MONEY_RE.test(f.replace(/\/route\.ts$/, '')) && g.seat !== 'owner' && g.seat !== 'legacy' && g.seat !== 'public')
      .map(([f, g]) => `${f}: ${g.seat}`);
    expect(open).toEqual([]);
  });

  for (const [file, gate] of Object.entries(GATES)) {
    describe(file, () => {
      const c = () => code(read(file));

      if (gate.seat === 'owner') {
        it('каждый обработчик — только владельцу кабинета', () => {
          const src = c();
          const hs = handlers(src);
          expect(hs.length).toBeGreaterThan(0);
          const fns = helpers(src);
          const gateRe = withAliases(OWNER_GATE, src);
          const open = hs.filter(h => !handlerReaches(h.body, gateRe, fns)).map(h => h.name);
          expect(open, 'обработчик денег или настроек без requireOperatorOwner/requirePartnerOwner').toEqual([]);
        });
      }

      if (gate.seat === 'team') {
        it('кабинет находит общий резолвер, своего поиска по user_id нет', () => {
          const src = c();
          const hs = handlers(src);
          expect(hs.length).toBeGreaterThan(0);
          const fns = helpers(src);
          const teamRe = withAliases(TEAM_RESOLVER, src);
          const ownerRe = withAliases(OWNER_GATE, src);
          const blind = hs
            .filter(h => !handlerReaches(h.body, teamRe, fns) && !handlerReaches(h.body, ownerRe, fns))
            .map(h => h.name);
          expect(blind, 'обработчик без резолвера кабинета').toEqual([]);
          expect(INLINE_OWNER_LOOKUP.test(src), 'поиск кабинета по user_id владельца закрывает роут менеджеру').toBe(false);
        });

        it('права менеджера объявлены ровно те, что проверяет код', () => {
          expect(permsInCode(c()).sort()).toEqual([...(gate.perms ?? [])].sort());
        });

        it('действия только владельцу объявлены, если код их делает', () => {
          expect(OWNER_ACTION.test(c())).toBe(Boolean(gate.ownerOnly));
        });

        it('деньги вынимаются на сервере ровно там, где объявлено', () => {
          expect(MONEY_HIDDEN.test(c())).toBe(Boolean(gate.moneyHidden));
        });
      }

      if (gate.seat === 'user') {
        it('кабинет не ищется вовсе', () => {
          const src = c();
          expect(gate.why.length).toBeGreaterThan(20);
          expect(TEAM_RESOLVER.test(src)).toBe(false);
          expect(OWNER_GATE.test(src)).toBe(false);
          expect(/FROM\s+partners\b/i.test(src)).toBe(false);
        });
      }

      if (gate.seat === 'legacy') {
        it('ищет кабинет по user_id владельца — менеджеру закрыт; переведённый требует снять запись', () => {
          expect(gate.why).toMatch(/2г-\d/);
          const src = c();
          const lookupSrc = gate.lookupIn ? code(read(gate.lookupIn)) : src;
          expect(INLINE_OWNER_LOOKUP.test(lookupSrc), 'старого поиска нет — объявите роут командным или владельческим').toBe(true);
          expect(TEAM_RESOLVER.test(src), 'роут переведён на общий резолвер — снимите запись legacy').toBe(false);
        });
      }

      if (gate.seat === 'public') {
        it('без входа, и это названо', () => {
          expect(gate.why.length).toBeGreaterThan(20);
          expect(AUTH_CALL.test(c())).toBe(false);
        });
      }
    });
  }
});

describe('экраны кабинета ходят только в объявленные роуты', () => {
  it('каждый адрес /api/ из app/hub/operator и components/operator — в реестре или у другого сторожа', () => {
    const urls = apiUrlsIn([...sourceFiles('app/hub/operator'), ...sourceFiles('components/operator')]);
    expect(urls.size).toBeGreaterThan(20);
    const unknown: string[] = [];
    for (const url of urls) {
      const file = resolveRoute(url);
      if (!file) { unknown.push(`${url} → роута нет`); continue; }
      if (file in GATES) continue;
      if (Object.keys(HELD_ELSEWHERE).some(prefix => file.startsWith(prefix))) continue;
      unknown.push(`${url} → ${file}`);
    }
    expect(unknown, 'экран кабинета зовёт роут, которого нет в реестре гейтов').toEqual([]);
  });
});
