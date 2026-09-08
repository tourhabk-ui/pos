/**
 * tests/unit/source-probe-personas.test.ts
 *
 * Проба спрашивает адрес ДВУМЯ обличьями и различает две разные беды.
 *
 * 08.09: publication.pravo.gov.ru не ответил ни раннеру (вне РФ), ни проду
 * (в РФ), причём молчал даже КОРЕНЬ сайта. Версию про гео-блок это сняло:
 * обе точки зрения дали одно и то же. Осталась вторая правдоподобная причина —
 * государственные порталы часто отсекают машинных клиентов по виду заголовков.
 *
 * «Нас отсекают по виду клиента» и «адрес недостижим» — разные беды с разной
 * починкой, и различить их можно только спросив дважды. Сторож держит, что
 * второе обличье не выродилось обратно в одно и что вывод по паре попыток
 * остался различающим.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/source-probe/route.ts'), 'utf-8');

describe('два обличья запроса', () => {
  it('обличий ровно два и они названы', () => {
    expect(SRC).toMatch(/PERSONAS\s*=\s*\{/);
    expect(SRC).toMatch(/\bbot:/);
    expect(SRC).toMatch(/\bbrowser:/);
  });

  it('браузерное обличье несёт то, по чему отсекают: не только User-Agent', () => {
    // Отсечение чаще идёт по совокупности — голый запрос без Accept и
    // Accept-Language виден серверу так же ясно, как чужой User-Agent.
    expect(SRC).toMatch(/'Accept':/);
    expect(SRC).toMatch(/'Accept-Language':/);
  });

  it('каждый адрес спрашивается обоими, а не одним', () => {
    expect(SRC).toMatch(/attempt\(c\.url,\s*'bot'\)/);
    expect(SRC).toMatch(/attempt\(c\.url,\s*'browser'\)/);
  });

  it('вывод по паре попыток различает четыре исхода', () => {
    for (const v of ['открыт', 'отсекают по виду клиента', 'недостижим', 'ответил только боту']) {
      expect(SRC, `исход «${v}» пропал из вывода`).toContain(v);
    }
  });

  it('ответ каждой попытки виден отдельно, а не только итог', () => {
    // Иначе «отсекают» пришлось бы принимать на веру: коды и размеры тел —
    // это улика, по которой человек проверит вывод пробы.
    expect(SRC).toMatch(/attempts:\s*\{\s*bot,\s*browser\s*\}/);
  });
});

describe('заголовки безопасны для undici и не притворяются человеком', () => {
  it('в значениях заголовков нет кириллицы', () => {
    // Кириллица в значении заголовка роняет fetch на undici — беда, уже
    // случавшаяся в этом репозитории.
    const personas = SRC.slice(SRC.indexOf('const PERSONAS'), SRC.indexOf('type Persona'));
    expect(/[А-Яа-яЁё]/.test(personas), 'кириллица в заголовке сломает fetch').toBe(false);
  });

  it('ни куки, ни авторизации к чужому сайту не подставляется', () => {
    // Браузерное обличье — это про вид клиента, а не про обход доступа:
    // сессий мы не подделываем и закрытое не открываем.
    const personas = SRC.slice(SRC.indexOf('const PERSONAS'), SRC.indexOf('type Persona'));
    expect(/Cookie|Authorization/i.test(personas)).toBe(false);
  });
});

describe('роут остаётся без параметров', () => {
  it('адреса зашиты списком, из запроса не берутся', () => {
    // Роут, ходящий по адресу из параметра, — это SSRF: сервер начнёт
    // стучаться куда попросят, включая внутреннюю сеть Timeweb.
    expect(SRC).toMatch(/const CANDIDATES/);
    expect(SRC).not.toMatch(/searchParams\.get\(\s*['"]url/);
  });
});
