/**
 * Фото места: вход спрашивается ДО работы, снимков до пяти.
 *
 * Владелец 21.08 на Диких озерках получил «Не авторизован» уже после того,
 * как выбрал снимок и напечатал подпись, — и был уверен, что вошёл, потому
 * что шапка показывала значок аккаунта всем подряд.
 *
 * Здесь стерегутся три черты, а не вёрстка:
 *  1. Загрузчик спрашивает вход сам и говорит словами со ссылкой.
 *  2. У состояния входа три исхода, и «не знаю» не равно «гость».
 *  3. Потолок снимков в форме тот же, что на сервере: одно число.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const upload = readFileSync(join(process.cwd(), 'components/places/PhotoUpload.tsx'), 'utf-8');
const header = readFileSync(join(process.cwd(), 'components/layout/Header.tsx'), 'utf-8');
const api = readFileSync(join(process.cwd(), 'app/api/places/[id]/photos/route.ts'), 'utf-8');

describe('загрузка фото места', () => {
  it('вход спрашивается до выбора снимка, не после подписи', () => {
    expect(upload).toContain("fetch('/api/auth/me'");
    expect(upload).toContain('Войти, чтобы добавить фото');
  });

  it('у входа три исхода, и «не знаю» не выдаётся за «гость»', () => {
    expect(upload).toMatch(/type AuthState = 'unknown' \| 'in' \| 'out'/);
    // Ссылка на вход показывается ТОЛЬКО при явном 'out'.
    expect(upload).toMatch(/auth === 'out' &&/);
    expect(upload).not.toMatch(/auth !== 'in' &&\s*\(\s*<a/);
  });

  it('выбирается несколько снимков, потолок совпадает с серверным', () => {
    expect(upload).toContain('multiple');
    expect(upload).toMatch(/const MAX_PHOTOS = 5/);
    expect(api).toMatch(/>= 5/);
    expect(api).toContain('Максимум 5 фото на место');
  });

  it('куки идут явно — запрос не должен уйти безымянным', () => {
    const posts = upload.match(/credentials: 'include'/g) ?? [];
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });

  it('отказ по одному снимку не отменяет остальные', () => {
    expect(upload).toMatch(/for \(let i = 0; i < next\.length; i\+\+\)/);
    expect(upload).toMatch(/next\[i\] = \{ \.\.\.next\[i\], error/);
  });
});

describe('шапка не изображает вход', () => {
  it('гостю показывается «Войти», вошедшему — кабинет', () => {
    expect(header).toMatch(/authed === false \? '\/auth\/login' : '\/profile'/);
    expect(header).toMatch(/authed === false \? 'Войти' : 'Личный кабинет'/);
  });

  it('пока ответа нет — значок прежний, никаких утверждений', () => {
    expect(header).toMatch(/useState<boolean \| null>\(null\)/);
    // Именно строгое сравнение с false: null не должен читаться как «гость».
    expect(header).not.toMatch(/!authed \?/);
  });
});
