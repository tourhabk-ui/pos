/**
 * Цена оператора и его имя в чате — из одного источника.
 *
 * Владелец на живой карточке 05.08: «от 10 000 ₽» при реальной цене оператора
 * 13 000 ₽, а кнопка «Написать» открывает диалог с «Рога и Копыта».
 *
 * Про имя — недоделка, а не новый баг. Миграция 810 перепривязала ТУР к
 * реальному партнёру, и на карточке имя стало правильным. Но чат берёт имя
 * собеседника не из `partners`, а из `users` (`other_p.name` в
 * chat.service.ts): аккаунт за партнёром остался с демо-именем. Одно и то же
 * имя жило в двух местах, починили одно.
 *
 * Про цену: расхождение с ценой продавца для коммерческого продукта — не
 * опечатка, а обещание, которого никто не выполнит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const M = read('migrations/815_bystraya_price_and_operator_name.sql');
const CHAT = read('lib/services/operators/chat.service.ts');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 815: цена и имя оператора', () => {
  it('ставит настоящую цену оператора', () => {
    expect(sql).toMatch(/base_price = 13000/);
  });

  it('цена не переписывается повторно — условие идемпотентности', () => {
    expect(sql).toMatch(/base_price IS DISTINCT FROM 13000/);
  });

  it('чинит имя аккаунта, стоящего за реальным партнёром', () => {
    expect(sql).toMatch(/UPDATE users/);
    expect(sql).toMatch(/slug = 'kamchatka-rafting'/);
    expect(sql).toMatch(/u\.id = p\.user_id/);
  });

  it('трогает только запись с демо-именем — чужие аккаунты не задеты', () => {
    expect(sql).toMatch(/name ILIKE '%рога%копыт%'/i);
  });

  it('без INSERT: partners старше системы миграций', () => {
    // INSERT в partners уронил 806 и стоил трёх дней разбирательств.
    expect(sql).not.toMatch(/INSERT INTO/i);
  });

  it('тур находится по содержанию, а не по хрупкому заголовку', () => {
    expect(sql).toMatch(/title ILIKE '%быстр%'/);
    expect(sql).toMatch(/LIMIT 1/);
  });
});

describe('имя собеседника в чате действительно берётся из users', () => {
  it('источник — users, а не partners', () => {
    // Если источник сменится на partners.name, правка users станет мёртвой, а
    // сторож — ложно-зелёным. Тогда этот тест должен упасть и заставить думать.
    expect(CHAT).toMatch(/other_p\.name as other_participant_name/);
    expect(CHAT).toMatch(/LEFT JOIN users other_p/);
  });
});
