/**
 * Ставку агентской ссылки назначает платформа, а не агент.
 *
 * ── Что чинилось 20.09 (issue #1978) ──────────────────────────────────────
 *
 * Владелец попросил запустить программу креаторов. Механизм под неё в
 * платформе уже был — агентские ссылки, счётчик кликов, атрибуция брони
 * через `operator_bookings.referral_link_id`, кабинет. При чтении нашлись
 * две вещи на денежном пути:
 *
 *   • `commissionRate` приходил ТЕЛОМ ЗАПРОСА от самого агента, до 30%;
 *   • кабинет показывал ему «заработано» = оплаченные брони × эта ставка,
 *     а пути выплаты агенту в платформе нет вовсе.
 *
 * Правило платформы на этот счёт уже записано и оплачено делом (§7, разбор
 * 11.09): ставку назначает владелец, её не меняет никакой автомат. Там был
 * автомат — функция, уводившая ставку по лестнице за объём. Здесь хуже:
 * контрагент.
 *
 * Перепись с прода (`referral-census`, прогон 561) показала ноль по всем
 * строкам: ссылок 0, агентов 0, обещано 0 ₽. Ни одной ставки никто себе не
 * назначил — дефект найден до того, как им воспользовались.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * 1. Агент не может задать ставку: ни через схему, ни телом запроса.
 * 2. Ссылка создаётся с ЯВНЫМ NULL, а не пропуском колонки (пропуск вернул
 *    бы умолчание, если его заведут обратно) — и умолчание снято миграцией.
 * 3. Назначение ставки существует и требует автора и основания. Снять
 *    возможность и не дать взамен значило бы завести обещание без механизма.
 * 4. `Number(null)` нигде не превращает «ставки нет» в ноль — ни на сервере,
 *    ни на экране. Этой ловушкой уже была испорчена комиссия платформы.
 *
 * ── 26.09: ставка одна на агента ──────────────────────────────────────────
 *
 * У брони, оформленной агентом за клиента, ссылки нет, и ставка на ссылке
 * оставила бы такие продажи без ставки навсегда. Рука владельца теперь
 * назначает ставку АГЕНТУ (POST /api/admin/agent-commission/rate,
 * partners.agent_commission_rate, миграция 1023); рука ссылок снята. Всё
 * прочее держится так же: автор, основание, ноль ≠ пустота.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Код без комментариев.
 *
 * Отрицательные проверки («такой формы больше нет») обязаны смотреть на
 * КОД. В шапках этих файлов прежние формы процитированы намеренно — там
 * записано, что именно чинилось, — и сторож, читающий файл целиком, краснел
 * на собственном объяснении. Это уже третий случай за день: дважды сторож
 * ловил слово `<details>` из комментария вместо разметки.
 *
 * Положительные проверки читают файл ЦЕЛИКОМ: им важно и то, что написано
 * словами (например, что роут не притворяется выплатой).
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const at = l.indexOf('//');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

const ROOT = process.cwd();
const CABINET  = readFileSync(join(ROOT, 'app/api/hub/agent/referral/route.ts'), 'utf-8');
const ADMIN    = readFileSync(join(ROOT, 'app/api/admin/agent-commission/rate/route.ts'), 'utf-8');
const MONEY    = readFileSync(join(ROOT, 'lib/payments/agent-commission.ts'), 'utf-8');
const RATE_MIGRATION = readFileSync(join(ROOT, 'migrations/1023_agent_commission_rate.sql'), 'utf-8');
const UI       = readFileSync(join(ROOT, 'app/hub/agent/referral/_ReferralClient.tsx'), 'utf-8');
const MIGRATION = readFileSync(join(ROOT, 'migrations/1005_agent_rate_is_owner_decision.sql'), 'utf-8');

const CABINET_CODE = codeOnly(CABINET);
const ADMIN_CODE   = codeOnly(ADMIN);
const UI_CODE      = codeOnly(UI);

describe('агент не назначает себе ставку', () => {
  it('схема создания ссылки не принимает commissionRate', () => {
    expect(CABINET_CODE).not.toMatch(/commissionRate:\s*z\./);
    expect(CABINET_CODE).not.toMatch(/min\(1\)\.max\(30\)\.default\(10\)/);
  });

  it('присланная ставка ОТКЛОНЯЕТСЯ, а не выбрасывается молча', () => {
    // Молчаливое выбрасывание оставило бы у клиента впечатление, что ставка
    // задана: он ждал бы тридцать процентов, а получил бы пустоту.
    expect(CABINET).toMatch(/'commissionRate' in body/);
    expect(CABINET).toMatch(/назначает владелец платформы, а не агент/);
    expect(CABINET).toMatch(/status:\s*400/);
  });

  it('ссылка создаётся с ЯВНЫМ NULL, а не пропуском колонки', () => {
    expect(CABINET).toMatch(/VALUES \(\$1, \$2, \$3, NULL, \$4\)/);
    // Пропуск колонки вернул бы умолчание, если его заведут обратно.
    expect(CABINET_CODE).not.toMatch(/\(agent_id, tour_id, code, expires_at\)/);
  });

  it('интерфейс кабинета больше не шлёт ставку', () => {
    expect(UI_CODE).not.toMatch(/commissionRate:\s*10/);
  });

  it('умолчание DEFAULT 10 снято миграцией', () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN commission_rate DROP DEFAULT/);
  });
});

describe('ставку назначает ВЛАДЕЛЕЦ, с автором и основанием', () => {
  it('рука существует и закрыта админским гейтом', () => {
    expect(ADMIN).toMatch(/export async function POST\(/);
    expect(ADMIN).toMatch(/requireAdmin/);
  });

  it('сказано, что процент назначает человек, а не «платформа»', () => {
    // Поправка владельца 20.09: «процент я буду применять и назначать сам а
    // не платформа». Разница не в вежливости: «платформа назначает» читается
    // как автомат, а правило §7 запрещает ровно автомат. Слово проверяется
    // там, где его видит человек, — в тексте отказа и в шапке руки.
    expect(ADMIN).toMatch(/рука ВЛАДЕЛЬЦА/);
    expect(ADMIN).toMatch(/[Пп]латформа тут только записывает/);
  });

  it('основание обязательно и не может быть галочкой', () => {
    expect(ADMIN).toMatch(/reason:\s*z\.string\(\)/);
    expect(ADMIN).toMatch(/\.min\(8,/);
  });

  it('автор и время пишутся вместе со ставкой', () => {
    expect(ADMIN).toMatch(/AGENT_MONEY_SQL\.setRate, \[partnerId, rate, auth\.userId, reason\]/);
    expect(MONEY).toMatch(/agent_rate_set_by\s*=\s*\$3::uuid/);
    expect(MONEY).toMatch(/agent_rate_set_at\s*=\s*NOW\(\)/);
    expect(MONEY).toMatch(/agent_rate_reason\s*=\s*\$4/);
    expect(RATE_MIGRATION).toMatch(/agent_rate_set_by/);
    expect(RATE_MIGRATION).toMatch(/agent_rate_set_at/);
    expect(RATE_MIGRATION).toMatch(/agent_rate_reason/);
  });

  it('ставка одна на агента: у записи агента, а не у ссылки', () => {
    expect(RATE_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS agent_commission_rate NUMERIC\(5,2\) NULL/);
    expect(RATE_MIGRATION).toMatch(/category = 'agent' AND agent_commission_rate >= 0 AND agent_commission_rate <= 30/);
    // Перенос ставок ссылок — только однозначный: разные ставки не выбираются за владельца.
    expect(RATE_MIGRATION).toMatch(/x\.distinct_rates = 1/);
    // Деньги читают ставку агента, а не ссылки.
    expect(MONEY).toMatch(/p\.agent_commission_rate::text AS rate/);
    expect(codeOnly(MONEY)).not.toMatch(/rl\.commission_rate/);
  });

  it('ноль разрешён как решение, и это не то же, что «не назначена»', () => {
    // «Вознаграждения нет» — законный ответ владельца; «ставка не назначена»
    // — отсутствие ответа. Нижняя граница 0, а не 1 (§7, «ноль — не пустота»).
    expect(ADMIN).toMatch(/rate:\s*z\.number\(\)\.min\(0\)\.max\(AGENT_RATE_MAX\)\.nullable\(\)/);
  });

  it('агента нет — отказ, а не тихий ноль строк', () => {
    expect(ADMIN).toMatch(/rows\.length === 0/);
    expect(ADMIN).toMatch(/status:\s*404/);
  });

  it('прежняя рука ставки ССЫЛКИ снята: ставка одна', () => {
    expect(() => readFileSync(join(ROOT, 'app/api/admin/agent-referral/rate/route.ts'), 'utf-8')).toThrow();
  });

  it('комиссия платформы с оператора этим роутом не трогается', () => {
    // Другая величина другой стороны — она живёт под §7 и своим сторожем.
    // Проверяется ВЕСЬ файл, не только код: сторож `commission-rate-decided`
    // ищет имя той колонки по тексту, и упоминание даже в комментарии
    // потребовало бы от роута объявить ответ на пустую ставку, которой он не
    // касается. Один лишний абзац в комментарии — и реестр читателей денег
    // наполняется файлами, денег не читающими.
    expect(ADMIN).not.toMatch(/commission_current/);
  });
});

describe('пустая ставка нигде не становится нулём', () => {
  it('на сервере без ставки агента итог — null, а не ноль', () => {
    expect(CABINET_CODE).toMatch(/if \(money\.rate === null\) return null/);
    expect(CABINET_CODE).toMatch(/totalEarned:\s*money\.rate === null\s*\? null/);
    // Прежняя форма суммировала Number(null) как ноль по ВСЕМ строкам.
    expect(CABINET_CODE).not.toMatch(/rows\.reduce\(\(s, r\) => s \+ Number\(r\.earned_total\), 0\)/);
    // И деньги — из единственной функции, а не ставкой ссылки по всем оплаченным.
    expect(CABINET_CODE).toMatch(/loadAgentMoney\(pool, auth\.userId\)/);
    expect(CABINET_CODE).not.toMatch(/commission_rate \/ 100/);
  });

  it('заработок превращается в рубли только после проверки на пустоту', () => {
    const guard = UI_CODE.indexOf('link.earned_total === null');
    const used  = UI_CODE.indexOf('money(link.earned_total)');
    expect(guard, 'проверки на пустой заработок нет вовсе').toBeGreaterThan(-1);
    expect(used, 'заработок нигде не показывается').toBeGreaterThan(-1);
    expect(guard, 'рубли считаются раньше проверки').toBeLessThan(used);
    expect(UI).toMatch(/заработок не считается/);
    expect(UI).toMatch(/stats\.totalEarned === null/);
    expect(UI).toMatch(/ставка не назначена/);
  });

  it('типы допускают отсутствие — иначе пустоту нечем выразить', () => {
    expect(UI).toMatch(/earned_total:\s*number \| null/);
    expect(UI).toMatch(/totalEarned:\s*number \| null/);
    expect(UI).toMatch(/rate:\s*number \| null/);
  });
});
