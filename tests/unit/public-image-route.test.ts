/**
 * Сторож публичности адреса снимков (07.09).
 *
 * Замер с прода: `GET /api/images/route/<uuid>` отвечал **401 «Не
 * авторизован»**. Middleware закрывает ЛЮБОЙ `/api/*`, не внесённый в реестр
 * публичных, а этот адрес там не значился.
 *
 * Цена молчания оказалась двойной, и обе стороны видны снаружи:
 *
 *  - канал Кузьмича: место для поста выбирается ТОЛЬКО со своим фото
 *    (условие в SQL), но Telegram скачать кадр не мог — и каждый пост честно
 *    откатывался в текст. Владелец: «ни одной фотографии»;
 *  - сайт: `/api/trending` публично отдаёт `image_url` ровно этого вида,
 *    значит у гостя карточка места оставалась без снимка.
 *
 * Правило, которое держит сторож: адрес, ссылки на который платформа отдаёт
 * НЕАВТОРИЗОВАННОМУ читателю, обязан быть публичным. Иначе мы публикуем
 * ссылку, по которой сами же отвечаем 401.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

describe('снимки мест открыты тому, кто их скачивает', () => {
  it('адрес снимка публичен для GET', () => {
    expect(isPublicApiPath('/api/images/route/36214e49-de02-4d1b-8f71-1926a1b319fa', 'GET')).toBe(true);
  });

  it('запись по этому адресу публичной не становится', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(isPublicApiPath('/api/images/route/36214e49-de02-4d1b-8f71-1926a1b319fa', m), m).toBe(false);
    }
  });

  it('соседние адреса не открылись заодно', () => {
    expect(isPublicApiPath('/api/admin/places/search', 'GET')).toBe(false);
  });
});

describe('отказ хранилища не выдаётся за отсутствие снимка', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/images/route/[routeId]/route.ts'), 'utf8');

  it('catch пишет причину в лог, а не молчит', () => {
    expect(SRC).not.toMatch(/\}\s*catch\s*\{\s*\n\s*return new NextResponse\('Image unavailable'/);
    expect(SRC).toMatch(/console\.error\('\[images\]/);
  });
});
