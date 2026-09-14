/**
 * Один звонок на тип опасности, пока прежний ещё действует (владелец 14.09).
 *
 * ── Что случилось ──────────────────────────────────────────────────────────
 *
 * В 10:12 на телефон владельца пришли ТРИ уведомления подряд, все с одним
 * заголовком «Паводок — Камчатка»: экстренное предупреждение на 14 сентября,
 * фраза про достижение уровня опасного явления и новость о выезде спасателей
 * МЧС в Соболево. Для человека это одно событие — и три раза подряд.
 *
 * Механизм двухслойный, и оба слоя работали «правильно»:
 *
 *   1. Контент-дедуп (`seismic-parser.saveEvent`) сверяет ПАРУ заголовок +
 *      описание. У трёх разных постов МЧС об одном паводке они разные —
 *      значит три строки `external_alerts`, и это не ошибка дедупа: посты
 *      действительно разные тексты.
 *   2. `dispatchPushAlerts` шлёт ровно один push на строку и ставит каждому
 *      свой `tag: alert-<id>`. Одинаковые теги на телефоне ЗАМЕНЯЮТ друг
 *      друга, разные — ложатся стопкой. Три строки — три тега — три звонка.
 *
 * Прецедент в репозитории уже был: 06.09 ровно это случилось с
 * `road_closure` (5-6 push об одном перекрытии), и тогда тип просто убрали из
 * push. Здесь так нельзя: «не пересекайте реки вброд» — полевая инструкция,
 * ради которой push и существует.
 *
 * ── Почему глушить можно ───────────────────────────────────────────────────
 *
 * Второе уведомление не несло НИ ОДНОГО сведения, которого не было в первом.
 * Заголовок push называет тип и край целиком, района в нём нет вовсе, а
 * инструкция берётся по типу и у всех паводков одна. Теряется звонок, не
 * факт: алерт целиком остаётся на /safety.
 *
 * Два предохранителя проверяются ниже отдельно — на них всё и держится:
 * тяжесть ВЫШЕ прежней проходит всегда, а цунами не глушится никогда.
 *
 * ── Почему нужна отдельная колонка ─────────────────────────────────────────
 *
 * Пометить заглушённый алерт через `push_sent_at` было бы проще всего — и это
 * была бы ложь в данных ровно того рода, о котором §4.0: «не стали слать»
 * выдано за «отправили», и недоставка спряталась бы от сторожа, который
 * следит за молчащим push. Третий исход обязан называться своим именем и
 * нести причину.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
/** Код без комментариев: прежнее поведение в них описано намеренно. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MIGRATION = readFileSync(
  join(process.cwd(), 'migrations/957_external_alerts_push_suppressed.sql'),
  'utf-8',
);

/** Тело dispatchPushAlerts — чтобы судить рассылку, а не весь роут. */
const DISPATCH = (() => {
  const start = CODE.indexOf('async function dispatchPushAlerts');
  expect(start, 'dispatchPushAlerts не найден').toBeGreaterThan(-1);
  const end = CODE.indexOf('interface ParseResultSummary', start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
})();

describe('второй звонок об одном типе не уходит', () => {
  it('перед отправкой спрашивается, не звонили ли уже об этом типе', () => {
    expect(DISPATCH).toMatch(/FROM external_alerts[\s\S]{0,200}WHERE alert_type = \$1/);
    expect(DISPATCH).toMatch(/push_sent_at IS NOT NULL/);
  });

  it('считается только ДЕЙСТВУЮЩИЙ прежний алерт', () => {
    // Без `expires_at > NOW()` давнее предупреждение глушило бы новое
    // навсегда: тип один, а обстановка давно другая.
    expect(DISPATCH).toMatch(/push_sent_at IS NOT NULL\s*\n\s*AND expires_at > NOW\(\)/);
  });

  it('сам себя алерт заглушить не может', () => {
    // Без `id <> $2` строка, которой только что поставили push_sent_at,
    // на следующем прогоне нашла бы саму себя.
    expect(DISPATCH).toMatch(/AND id <> \$2/);
  });
});

describe('предохранители правила', () => {
  it('тяжесть ВЫШЕ прежней проходит всегда', () => {
    // Условие именно «прежний не слабее». Развитие обстановки — это то, ради
    // чего push существует; заглушить его значило бы выключить сигнализацию.
    expect(DISPATCH).toMatch(/COALESCE\(severity, 0\) >= COALESCE\(\$3::int, 0\)/);
  });

  it('цунами не глушится никогда', () => {
    // Повторное предупреждение о цунами может нести другую волну и другое
    // время подхода, и цена ошибки здесь не такая, как у прочих типов.
    expect(DISPATCH).toMatch(/alert\.alert_type !== 'tsunami_warning'/);
  });

  it('severity действительно выбирается — иначе сравнивать нечего', () => {
    expect(DISPATCH).toMatch(/SELECT id, alert_type, severity/);
  });
});

describe('«не стали слать» не выдаётся за «отправили»', () => {
  it('заглушение пишется в своё поле, а не в push_sent_at', () => {
    expect(DISPATCH).toMatch(/SET push_suppressed_at = NOW\(\), push_suppressed_reason = \$2/);
    // Ровно одно место ставит push_sent_at — успешная доставка.
    expect(DISPATCH.match(/SET push_sent_at = NOW\(\)/g) ?? []).toHaveLength(1);
  });

  it('причина обязательна и называет заглушивший алерт', () => {
    // «Тихо, потому что тихо» через месяц не расследуется.
    expect(DISPATCH).toMatch(/const reason = `дубль по типу/);
    expect(DISPATCH).toMatch(/louder\.rows\[0\]\.id/);
  });

  it('заглушённые уходят из выборки, а не перебираются вечно', () => {
    expect(DISPATCH).toMatch(/AND push_suppressed_at IS NULL/);
  });

  it('число заглушённых видно в ответе и отделено от недоставленных', () => {
    // Свести их в одно число значило бы спрятать один исход за другим.
    expect(CODE).toMatch(/push_alerts_suppressed: pushResult\?\.suppressed \?\? 0/);
    expect(DISPATCH).toMatch(/skipped: rows\.length - dispatched - suppressed/);
  });
});

describe('миграция 957', () => {
  it('идемпотентна — катится на каждом деплое', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS push_suppressed_at/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS push_suppressed_reason/);
  });

  it('индекс отсева учитывает ОБА решения, а не одно', () => {
    // Частичный индекс по push_sent_at IS NULL без второго условия перестал
    // бы покрывать выборку в тот же день, когда появилась заглушка.
    expect(MIGRATION).toMatch(/WHERE push_sent_at IS NULL AND push_suppressed_at IS NULL/);
  });
});
