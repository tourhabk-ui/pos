/**
 * Подпись initData мини-приложения (план §6.2, этап 0): вызов на подписанных
 * строках, у каждого отказа своя причина, «не настроено» не равно ни «ок», ни
 * «подделка». Подпись в тесте собрана независимо от модуля — по документации
 * MAX и Telegram.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_AGE_SEC, verifyInitData } from '@/lib/miniapp/init-data';

const TOKEN = 'test-bot-token-31-10';
const NOW = 1_790_000_000;
const ENV = { MAX_BOT_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: 'tg-' + TOKEN } as unknown as NodeJS.ProcessEnv;

function sign(fields: Record<string, string>, token = TOKEN): string {
  const line = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', key).update(line).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
const USER = JSON.stringify({ id: 4242, first_name: 'Андрей', username: 'andrey' });
const fresh = (extra: Record<string, string> = {}) => ({ auth_date: String(NOW - 30), query_id: 'q1', user: USER, ...extra });

describe('verifyInitData', () => {
  it('верная свежая подпись MAX и Telegram — ok с id пользователя', () => {
    const max = verifyInitData('max', sign(fresh()), { nowSec: NOW, env: ENV });
    expect(max).toMatchObject({ outcome: 'ok', platform: 'max', user: { id: 4242, username: 'andrey' }, authDate: NOW - 30 });
    const tg = verifyInitData('telegram', sign(fresh({ signature: 'abc' }), 'tg-' + TOKEN), { nowSec: NOW, env: ENV });
    expect(tg.outcome).toBe('ok');
  });

  it('нет токена бота — not_configured, а не подделка и не ок', () => {
    const none = {} as unknown as NodeJS.ProcessEnv;
    expect(verifyInitData('max', sign(fresh()), { nowSec: NOW, env: none })).toEqual({ outcome: 'not_configured' });
    expect(verifyInitData('max', sign(fresh()), { nowSec: NOW, env: { MAX_BOT_TOKEN: '  ' } as unknown as NodeJS.ProcessEnv }))
      .toEqual({ outcome: 'not_configured' });
  });

  it('подпись чужим токеном, правка поля, чужая платформа — bad_signature', () => {
    const other = sign(fresh(), 'другой-токен');
    expect(verifyInitData('max', other, { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'bad_signature' });
    const tampered = sign(fresh()).replace('4242', '4243');
    expect(verifyInitData('max', tampered, { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'bad_signature' });
    // подпись токеном MAX не годится для Telegram
    expect(verifyInitData('telegram', sign(fresh()), { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'bad_signature' });
  });

  it('нет hash, кривой hash, повтор ключа, пустая и огромная строка — отказ с причиной', () => {
    expect(verifyInitData('max', 'auth_date=1&user=%7B%7D', { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'no_hash' });
    expect(verifyInitData('max', 'auth_date=1&hash=zz', { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'malformed' });
    expect(verifyInitData('max', sign(fresh()) + '&user=%7B%7D', { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'malformed' });
    expect(verifyInitData('max', '', { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'malformed' });
    expect(verifyInitData('max', 'a=' + 'x'.repeat(9000), { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'malformed' });
  });

  it('окно: ровно в пределах — ок, на секунду старше — expired, из будущего больше минуты — from_future', () => {
    const at = (age: number) => sign(fresh({ auth_date: String(NOW - age) }));
    expect(verifyInitData('max', at(DEFAULT_MAX_AGE_SEC), { nowSec: NOW, env: ENV }).outcome).toBe('ok');
    expect(verifyInitData('max', at(DEFAULT_MAX_AGE_SEC + 1), { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'expired' });
    expect(verifyInitData('max', at(-60), { nowSec: NOW, env: ENV }).outcome).toBe('ok');
    expect(verifyInitData('max', at(-61), { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'from_future' });
    // окно называет владелец: свой срок вызывающего выше умолчания
    expect(verifyInitData('max', at(3600), { nowSec: NOW, env: ENV, maxAgeSec: 7200 }).outcome).toBe('ok');
  });

  it('подписано, но auth_date или user негодны — свои причины, а не ок', () => {
    const noDate = sign({ user: USER });
    expect(verifyInitData('max', noDate, { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'no_auth_date' });
    for (const bad of ['', 'не json', '{"id":"4242"}', '{"id":-1}', '[]']) {
      expect(verifyInitData('max', sign(fresh({ user: bad })), { nowSec: NOW, env: ENV })).toEqual({ outcome: 'forbidden', reason: 'no_user' });
    }
  });
});
