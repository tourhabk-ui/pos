/**
 * Зелёная сборка не означает живой продукт.
 *
 * 15–16.08 прод простоял с мёртвым выбором маршрута, и ни одна проверка этого
 * не увидела: unit-тесты зелёные, сборка успешна, `/version.json` отдавал
 * нужный коммит. Всё это доказывало «задеплоено» и ничего не говорило про
 * «работает» — каталог отвечал ошибкой БД, первый экран планировщика был пуст.
 *
 * Смоук по проду закрывает именно этот разрыв и потому обязателен в деплое.
 * Порядок принципиален: деплой → смоук → отметка здоровья. Смоук ДО публикации
 * проверял бы прошлую версию, то есть не проверял бы ничего.
 *
 * Отдельная и не менее важная половина сторожа — смоук ничего не пишет.
 * Он ходит по ПРОДУ: заявка от него это настоящая заявка с чужим телефоном
 * в базе оператора, а телефон — персональные данные (152-ФЗ, см. Compliance
 * Sentinel). Поэтому имена пишущих инструментов в скрипте запрещены.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const SMOKE = read('scripts/deploy-smoke.mjs');
const DEPLOY = read('.github/workflows/deploy.yml');

describe('смоук встроен в деплой, а не живёт рядом', () => {
  it('деплой запускает скрипт смоука', () => {
    expect(DEPLOY).toMatch(/node scripts\/deploy-smoke\.mjs/);
  });

  it('смоук идёт против реального домена, а не локального процесса', () => {
    // Локальный `next start` в CI отвечает на те же URL и ничего не доказывает
    // про опубликованный контейнер — а доказать нужно именно его.
    expect(DEPLOY).toMatch(/BASE_URL: https:\/\/vedarai\.ru/);
    expect(DEPLOY).not.toMatch(/BASE_URL: http:\/\/localhost/);
  });

  it('смоук стоит ПОСЛЕ подтверждения публикации', () => {
    const served = DEPLOY.indexOf('Деплой подтверждён фактом');
    const smoke = DEPLOY.indexOf('node scripts/deploy-smoke.mjs');
    expect(served).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(served);
  });

  it('деплой по-прежнему требует зелёного CI — добавлена проверка, а не замена', () => {
    expect(DEPLOY).toMatch(/workflow_run\.conclusion == 'success'/);
  });
});

describe('подтверждение деплоя: прод СОДЕРЖИТ коммит, а не равен ему', () => {
  it('успех считается по предкам, а не сравнением строк', () => {
    // 16.08: мерж и авто-коммит счётчиков README легли в main с разницей в
    // минуты. Timeweb собирает голову ветки, а не конкретный коммит: он собрал
    // потомка, прод получил фикс, а проверка ждала ровно наш SHA, не дождалась
    // за 20 минут и покраснела. Ложная тревога неотличима от настоящего
    // «автодеплой не сработал» — и следующая такая будет прочитана как шум.
    expect(DEPLOY).toMatch(/merge-base --is-ancestor/);
    expect(DEPLOY).toMatch(/contains_expected/);
  });

  it('обе фазы — и сборка, и отдача сайтом — идут через одну проверку', () => {
    const calls = DEPLOY.match(/contains_expected "\$(COMMIT|SERVED)"/g) ?? [];
    expect(calls).toHaveLength(2);
    // Прежних сравнений строк не осталось: иначе одна из фаз краснела бы.
    expect(DEPLOY).not.toMatch(/\$\{SERVED:0:7\}" != "\$\{EXPECTED_SHA:0:7\}/);
    expect(DEPLOY).not.toMatch(/if \[ "\$\{COMMIT:0:7\}" = "\$\{EXPECTED_SHA:0:7\}" \]; then PICKED/);
  });

  it('отставший прод по-прежнему провал — ослаблена точность, а не строгость', () => {
    // Предок нашего коммита это старый контейнер: откат или застрявшая сборка.
    expect(DEPLOY).toMatch(/::error::Сайт отдаёт .*не содержит/);
    expect(DEPLOY).toMatch(/::error::Timeweb за 20 минут не взял в работу/);
  });

  it('история доступна проверке: checkout с полной глубиной до неё', () => {
    const checkout = DEPLOY.indexOf('fetch-depth: 0');
    const verify = DEPLOY.indexOf('Verify deploy reached production');
    expect(checkout).toBeGreaterThan(-1);
    expect(checkout).toBeLessThan(verify);
  });
});

describe('смоук проверяет три вещи, а не факт ответа сервера', () => {
  it('каталог: не только HTTP 200, но success и непустой список', () => {
    // 15.08 каталог отдавал ровно HTTP 200 с success:false — проверка «сервер
    // ответил» прошла бы и в тот вечер.
    expect(SMOKE).toMatch(/has_waypoints=true/);
    expect(SMOKE).toMatch(/body\.success !== true/);
    expect(SMOKE).toMatch(/items\.length === 0/);
  });

  it('деталь маршрута: не меньше двух точек с координатами', () => {
    expect(SMOKE).toMatch(/valid\.length < 2/);
    expect(SMOKE).toMatch(/Number\.isFinite\(Number\(w\.lat\)\)/);
  });

  it('деталь не гаснет вместе с каталогом — проверки независимы', () => {
    // 16.08 каталог упал и деталь стала «не выполнена»: одна поломка погасила
    // две проверки.
    expect(SMOKE).toMatch(/api\/routes\/search\?q=/);
    const calls = SMOKE.match(/await run\('/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it('карточка проверяется на фикстуре, а не на первом попавшемся', () => {
    // Перебор выдачи до первого исправного маршрута позеленел бы, даже если
    // сломаны девять из десяти. Проверка, которая ищет, чем бы себя
    // удовлетворить, — не проверка.
    expect(SMOKE).toMatch(/process\.env\.SMOKE_ROUTE_ID/);
    expect(SMOKE).toMatch(/SMOKE_ROUTE_ID не задан/);
  });

  it('незаданная фикстура — падение, а не пропуск', () => {
    // Невыполненная проверка не имеет права выглядеть зелёной.
    const fn = SMOKE.slice(
      SMOKE.indexOf('async function checkRouteDetailFixture'),
      SMOKE.indexOf('async function checkRouteDetail('),
    );
    expect(fn).toMatch(/fail\(/);
    expect(fn).not.toMatch(/\bok\(/);
  });

  it('качество выдачи измеряется отдельно и падает на нуле пригодных', () => {
    expect(SMOKE).toMatch(/checkNavigableShare/);
    expect(SMOKE).toMatch(/ни один не имеет двух точек с координатами/);
    expect(SMOKE).toMatch(/годятся в фикстуру/);
  });

  it('MCP: рукопожатие, список и один читающий вызов', () => {
    expect(SMOKE).toMatch(/'initialize'/);
    expect(SMOKE).toMatch(/'tools\/list'/);
    expect(SMOKE).toMatch(/'tools\/call'/);
    expect(SMOKE).toMatch(/safety_status/);
  });

  it('провал смоука роняет прогон, а не печатает предупреждение', () => {
    expect(SMOKE).toMatch(/process\.exit\(1\)/);
  });
});

describe('смоук ничего не пишет в проде', () => {
  it('имён пишущих инструментов в скрипте нет', () => {
    // Заявка от смоука — настоящая заявка в базе оператора, с телефоном.
    expect(SMOKE).not.toMatch(/create_lead/);
    expect(SMOKE).not.toMatch(/create_booking_request/);
  });

  it('список разрешённых инструментов замкнут и состоит из чтения', () => {
    const m = SMOKE.match(/SMOKE_ALLOWED_MCP_TOOLS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const names = (m![1].match(/'([^']+)'/g) ?? []).map(s => s.replace(/'/g, ''));
    expect(names).toEqual(['safety_status']);
  });

  it('HTTP-методы записи к прикладным роутам не используются', () => {
    // POST есть только у JSON-RPC самого MCP — там это транспорт, не запись.
    const posts = SMOKE.match(/method: '(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(posts).toEqual(["method: 'POST'"]);
    expect(SMOKE).toMatch(/\$\{BASE\}\/api\/mcp/);
  });
});
