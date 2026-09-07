// @vitest-environment node
/**
 * Право запустить рассылку: свой секрет, постоянное время, три исхода.
 *
 * Разбор партии 1 (07.09). Оба роута кампании сверяли `X-CEO-Secret` с
 * `CRON_SECRET` оператором `!==`, а незащищённый GET рассказывал схему
 * доступа. Три беды в одной строке, и каждая своя:
 *
 *   1. общий секрет связал несвязанное — поворот секрета кронов ломал бы
 *      рассылку, а утечка одного давала бы и запуск кронов, и рассылку по
 *      чужим контактам;
 *   2. `!==` выходит на первом несовпавшем байте — секрет подбирается по
 *      времени ответа;
 *   3. GET был шпаргалкой: называл заголовок и источник секрета.
 *
 * Сторож держит все три и отдельно — что «не настроено» не равно «неверно».
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyCampaignSecret, CAMPAIGN_SECRET_HEADER } from '@/lib/sales/campaign-auth';

const ROOT = process.cwd();
const EXECUTE = readFileSync(join(ROOT, 'app/api/sales/campaign/execute/route.ts'), 'utf-8');
const LAUNCH = readFileSync(join(ROOT, 'app/api/sales/campaign/launch/route.ts'), 'utf-8');
const AUTH = readFileSync(join(ROOT, 'lib/sales/campaign-auth.ts'), 'utf-8');

const saved = process.env.SALES_CAMPAIGN_SECRET;
afterEach(() => {
  if (saved === undefined) delete process.env.SALES_CAMPAIGN_SECRET;
  else process.env.SALES_CAMPAIGN_SECRET = saved;
});

/**
 * Секрет в тестах ASCII, и это не косметика: заголовок HTTP не принимает
 * ничего вне ByteString, и кириллическое значение падает TypeError ещё до
 * сравнения. Первая редакция этого файла так и упала — заодно подтвердив,
 * что настоящий секрет обязан быть hex, как и написано в .env.example.
 */
const GOOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function headers(value?: string): Headers {
  const h = new Headers();
  if (value !== undefined) h.set(CAMPAIGN_SECRET_HEADER, value);
  return h;
}

describe('три исхода, и «не настроено» не равно «неверно»', () => {
  beforeEach(() => { process.env.SALES_CAMPAIGN_SECRET = GOOD; });

  it('верный секрет — можно', () => {
    expect(verifyCampaignSecret(headers(GOOD)).ok).toBe(true);
  });

  it('неверный секрет — 401 и без подробностей', () => {
    const v = verifyCampaignSecret(headers('0'.repeat(64)));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.status).toBe(401);
    // Подсказывать подбирающему, что именно не так, нечего.
    expect(!v.ok && v.error).toBe('Unauthorized');
  });

  it('заголовка нет вовсе — тот же 401, а не падение', () => {
    const v = verifyCampaignSecret(headers());
    expect(!v.ok && v.status).toBe(401);
  });

  it('секрет не настроен — 503, и сказано, что дело в сервере', () => {
    delete process.env.SALES_CAMPAIGN_SECRET;
    const v = verifyCampaignSecret(headers(GOOD));
    expect(v.ok).toBe(false);
    // Не 401: иначе владелец, забывший завести переменную, будет искать
    // ошибку в своих заголовках, а не в панели.
    expect(!v.ok && v.status).toBe(503);
    expect(!v.ok && v.error).toMatch(/SALES_CAMPAIGN_SECRET/);
    expect(!v.ok && v.error).toMatch(/не про ваш запрос/);
  });
});

describe('секрет свой, а не общий с кронами', () => {
  it('CRON_SECRET в проверке не участвует', () => {
    // Судим КОД, а не пояснения: в шапке модуля CRON_SECRET упоминается
    // намеренно — там объяснено, почему общий секрет убран.
    const code = AUTH
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('CRON_SECRET');
    expect(code).toContain('SALES_CAMPAIGN_SECRET');
  });

  it('отката на CRON_SECRET нет — иначе связь осталась бы', () => {
    expect(AUTH).not.toMatch(/SALES_CAMPAIGN_SECRET\s*\|\|\s*process\.env\.CRON_SECRET/);
  });

  it('оба роута сверяют секрет одной функцией, а не своей копией', () => {
    for (const [name, src] of [['execute', EXECUTE], ['launch', LAUNCH]] as const) {
      expect(src, `${name}: своя копия проверки разойдётся с общей`).toContain('verifyCampaignSecret(');
      expect(src, `${name}: прямое сравнение секрета осталось`).not.toMatch(/secret\s*!==\s*cronSecret/);
    }
  });
});

describe('сравнение по постоянному времени', () => {
  it('используется общая функция, а не оператор', () => {
    expect(AUTH).toContain('timingSafeCompare');
    expect(AUTH, 'сравнение строк оператором подбирается побайтно по времени')
      .not.toMatch(/headers\.get\([^)]*\)\s*!==/);
  });
});

describe('GET не рассказывает схему доступа', () => {
  it('ни имени заголовка, ни источника секрета в описании', () => {
    for (const [name, src] of [['execute', EXECUTE], ['launch', LAUNCH]] as const) {
      const get = src.slice(src.indexOf('export async function GET'));
      expect(get, `${name}: GET называет заголовок доступа`).not.toMatch(/X-CEO-Secret/);
      expect(get, `${name}: GET называет источник секрета`).not.toMatch(/CRON_SECRET|SALES_CAMPAIGN_SECRET/);
    }
  });
});
