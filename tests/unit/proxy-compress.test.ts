/**
 * Сжатие на прокси start.js (замер 02.10).
 *
 * Next отдаёт gzip страницы и /_next/static, а ответы Route Handlers —
 * сырыми: /map тянул 341 КБ JSON маршрутов вместо 73 КБ, sitemap.xml —
 * 176 КБ. Прокси сжимает то, что Next не сжал. Сторож держит правило
 * отбора (что сжимается, что нет) и то, что поток остаётся потоком.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(process.cwd(), 'start.js'), 'utf8');
const block = src.match(/\/\/ <shouldGzip>([\s\S]*?)\/\/ <\/shouldGzip>/);

type Headers = Record<string, string | undefined>;
type ShouldGzip = (method: string, status: number, headers: Headers, ae?: string) => boolean;
const shouldGzip = new Function(`${block?.[1] ?? ''}; return shouldGzip;`)() as ShouldGzip;

const json: Headers = { 'content-type': 'application/json' };
const AE = 'gzip, deflate, br';

describe('start.js: что сжимается', () => {
  it('правило отбора лежит между маркерами', () => {
    expect(block).not.toBeNull();
  });

  it('JSON, XML и текст без content-encoding — сжимаются', () => {
    expect(shouldGzip('GET', 200, json, AE)).toBe(true);
    expect(shouldGzip('GET', 200, { 'content-type': 'application/xml; charset=utf-8' }, AE)).toBe(true);
    expect(shouldGzip('GET', 200, { 'content-type': 'text/plain; charset=utf-8' }, AE)).toBe(true);
    expect(shouldGzip('GET', 404, json, AE)).toBe(true);
  });

  it('уже сжатое Next — не трогается', () => {
    expect(shouldGzip('GET', 200, { ...json, 'content-encoding': 'gzip' }, AE)).toBe(false);
  });

  it('клиент без gzip, HEAD, 204/206/304 — без сжатия', () => {
    expect(shouldGzip('GET', 200, json, 'br')).toBe(false);
    expect(shouldGzip('GET', 200, json, undefined)).toBe(false);
    expect(shouldGzip('HEAD', 200, json, AE)).toBe(false);
    for (const s of [204, 206, 304]) expect(shouldGzip('GET', s, json, AE)).toBe(false);
  });

  it('SSE, картинки и бинарное — без сжатия', () => {
    expect(shouldGzip('GET', 200, { 'content-type': 'text/event-stream' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, { 'content-type': 'image/jpeg' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, { 'content-type': 'application/pdf' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, { 'content-type': 'application/octet-stream' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, {}, AE)).toBe(false);
  });

  it('no-transform и ответы короче килобайта — без сжатия', () => {
    expect(shouldGzip('GET', 200, { ...json, 'cache-control': 'public, no-transform' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, { ...json, 'content-length': '512' }, AE)).toBe(false);
    expect(shouldGzip('GET', 200, { ...json, 'content-length': '4096' }, AE)).toBe(true);
  });
});

describe('start.js: как сжимается', () => {
  it('поток сбрасывается каждой порцией — потоковые ответы остаются потоковыми', () => {
    expect(src).toMatch(/createGzip\(\{[^}]*flush:\s*zlib\.constants\.Z_SYNC_FLUSH/);
  });

  it('длина снимается, Vary дополняется, отказ сжатия пишется в лог', () => {
    expect(src).toMatch(/delete headers\['content-length'\]/);
    expect(src).toMatch(/Accept-Encoding/);
    expect(src).toMatch(/gz\.on\('error'[\s\S]{0,80}console\.error/);
  });
});
