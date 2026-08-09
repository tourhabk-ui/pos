/**
 * Блок «Кто проводит» на карточке тура: лого партнёра и контакты.
 *
 * Владелец 09.08, скрин карточки «Камчатской рыбалки»: «это лого партнера и
 * нет контактов». Проба прода подтвердила две беды разом:
 *   - логотип лежит в `partners.logo_image` с 804, но карточка его никогда не
 *     запрашивала и рисовала букву в кружке;
 *   - телефоны, Telegram, TikTok и сайт есть в базе и доезжают до страницы, а
 *     кнопок нет НИ ОДНОЙ — значит `toContacts` получил не объект.
 *
 * Второе — тот же класс, что три находки 08.08: схема в миграциях
 * (`contacts JSONB`, 784) не обязана совпадать со схемой на проде, потому что
 * `ADD COLUMN IF NOT EXISTS` на существующей колонке — no-op. Лечится у
 * границы данных: `toContactsRecord` приводит значение к объекту, разбирая
 * строку, — и все читатели дальше работают с одной формой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toContactsRecord } from '@/lib/tours/tour-detail-query';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const QUERY = read('lib/tours/tour-detail-query.ts');
const CARD = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
const INSPECT = read('app/api/cron/inspect-tour-card/route.ts');

describe('контакты приводятся к объекту у границы данных', () => {
  it('строка с JSON разбирается — иначе карточка теряет ВСЕ контакты разом', () => {
    const r = toContactsRecord('{"phone":"+79990000000","tiktok":"kam"}');
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(['phone', 'tiktok']);
  });

  it('объект проходит как есть', () => {
    const src = { phone: '+79990000000' };
    expect(toContactsRecord(src)).toEqual(src);
  });

  it('мусор не роняет карточку: битый JSON, массив, число, пустая строка → null', () => {
    for (const bad of ['{не json', '[1,2]', '   ', '', 42, null, undefined, ['a'], true]) {
      expect(toContactsRecord(bad), `значение ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('строка с JSON-массивом — не контакты (у контактов форма объекта)', () => {
    expect(toContactsRecord('[{"phone":"+79990000000"}]')).toBeNull();
  });

  it('нормализация применяется В ОБОИХ ветках запроса (и без колонок 809)', () => {
    // Запасная ветка (миграция отстала) кормит ту же карточку — если забыть
    // нормализацию там, дефект вернётся ровно в тот день, когда миграция
    // отстанет, и объяснить его будет нечем.
    expect(QUERY).toMatch(/const normalize =/);
    expect(QUERY.match(/normalize\(rows\[0\]\)/g) ?? []).toHaveLength(2);
  });
});

describe('логотип партнёра на карточке', () => {
  it('запрос берёт logo_image, тип карточки его знает', () => {
    expect(QUERY).toMatch(/p\.logo_image AS operator_logo/);
    expect(QUERY).toMatch(/operator_logo: string \| null/);
    expect(CARD).toMatch(/operator_logo\?: string \| null/);
  });

  it('есть логотип — картинка, нет — прежняя буква в кружке', () => {
    expect(CARD).toMatch(/tour\.operator_logo \?/);
    expect(CARD).toMatch(/alt=\{`Логотип: \$\{tour\.operator_name\}`\}/);
    expect(CARD).toMatch(/tour\.operator_name\.charAt\(0\)\.toUpperCase\(\)/);
  });
});

describe('диагностика формы данных прода', () => {
  it('под секретом и read-only', () => {
    expect(INSPECT).toMatch(/verifyCronSecret/);
    expect(INSPECT).not.toMatch(/INSERT|UPDATE|DELETE|DROP|CREATE/);
  });

  it('наружу уходят типы и имена ключей, но не значения (152-ФЗ)', () => {
    expect(INSPECT).toMatch(/pg_typeof/);
    expect(INSPECT).toMatch(/Object\.keys/);
    // В ответе не должно быть ни одного места, где отдаётся сам объект
    // контактов: там телефоны партнёра, а лог Actions читается за границей.
    expect(INSPECT).not.toMatch(/contacts:\s*normalized/);
    expect(INSPECT).not.toMatch(/Object\.values/);
  });
});
