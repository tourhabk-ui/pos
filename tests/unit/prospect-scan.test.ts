/**
 * Роут разведки партнёров /api/cron/prospect-scan (#66, фаза 1).
 *
 * Сторож держит границы, за которые разведка выходить не должна:
 *  1. Закрыт CRON_SECRET — иначе чужой агент чужими руками сканирует сайты
 *     с нашего адреса.
 *  2. Ничего не пишет в БД: пока нет цифр по качеству разбора, таблицу
 *     заводить рано (не усложнять раньше времени).
 *  3. t.me сервером не тянется — гео-блок Timeweb. Честный отказ вместо
 *     таймаута, который читался бы как «у партнёра нет канала».
 *  4. Есть потолки: размер HTML, число адресов, таймаут; чужие сайты
 *     обходятся последовательно, а не залпом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/prospect-scan/route.ts'), 'utf-8');

describe('доступ и запись', () => {
  it('закрыт CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/getCronSecret\(request\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });

  it('в базу не пишет и к пулу не ходит', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(SRC).not.toMatch(/from '@\/lib\/db-pool'/);
  });
});

describe('Telegram: только публичное превью, только через раннер', () => {
  it('t.me сервером не тянется — отказ с объяснением', () => {
    expect(SRC).toMatch(/t\\?\.me\|telegram\\?\.me/);
    expect(SRC).toMatch(/недоступен с хостинга/);
  });

  it('имя канала валидируется, HTML приходит телом', () => {
    expect(SRC).toMatch(/channel: z\.string\(\)\.regex\(\/\^\[A-Za-z0-9_\]\{4,32\}\$\//);
    expect(SRC).toMatch(/channels_html/);
  });
});

describe('вежливость к чужим сайтам', () => {
  it('есть потолки на размер, количество и время', () => {
    expect(SRC).toMatch(/MAX_HTML\s*=\s*\d/);
    expect(SRC).toMatch(/FETCH_TIMEOUT_MS\s*=\s*\d/);
    expect(SRC).toMatch(/MAX_FETCH\s*=\s*\d/);
    expect(SRC).toMatch(/AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
  });

  it('обход последовательный, а не Promise.all залпом', () => {
    const block = SRC.slice(SRC.indexOf('for (const url of fetch_sites)'));
    expect(block).toMatch(/await fetchSite\(url\)/);
    expect(SRC).not.toMatch(/Promise\.all\(fetch_sites/);
  });

  it('представляется своим User-Agent со ссылкой на нас', () => {
    expect(SRC).toMatch(/VedarProspect/);
    expect(SRC).toMatch(/vedarai\.ru/);
  });
});

describe('выдача', () => {
  it('считает малых операторов — профиль из запроса владельца', () => {
    expect(SRC).toMatch(/small_operators/);
    expect(SRC).toMatch(/prospectSize/);
  });

  it('неудачные обходы видны, а не проглочены', () => {
    expect(SRC).toMatch(/sites_failed/);
  });
});
