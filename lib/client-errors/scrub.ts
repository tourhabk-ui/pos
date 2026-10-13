/**
 * lib/client-errors/scrub.ts — чистка и опознание ошибки браузера на сервере.
 *
 * Ловушка ошибок (решение владельца 13.10: «ловушку») принимает текст из
 * чужого браузера. В тексте ошибки бывает всё: адрес с ключом в query,
 * токен из заголовка, почта из формы. Сюда это не записывается: чистка
 * идёт до INSERT, а не на экране (pd-guard §2: лишнее убирать на входе).
 *
 * Отпечаток группы — по смыслу, не по тексту: номера строк и колонок в
 * стеке меняются от сборки к сборке, а ошибка та же.
 *
 * Только сервер: node:crypto. Клиентская часть — lib/client-errors/report.ts.
 */

import { createHash } from 'node:crypto';
import { redactPII } from '@/lib/security/pii-redact';

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'boundary'] as const;
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number];

/** Ключи и токены в тексте ошибки — показывать нельзя даже в переписи. */
const SECRET_RE = /\b(?:sk|xai|gsk|key|tok|token|api)[-_][A-Za-z0-9_-]{8,}/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]{8,}/gi;
/** Адрес внутри сообщения или стека — без query и фрагмента: там ключи и ПД. */
const URL_TAIL_RE = /(https?:\/\/[^\s?#"'()]+)[?#][^\s"')]*/g;
/** Длинные hex-строки — хэши и ключи, в группе ошибок они не нужны. */
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;

export function scrubErrorText(raw: string | null | undefined, max: number): string {
  if (!raw) return '';
  const t = String(raw)
    .replace(/\r/g, '')
    .replace(URL_TAIL_RE, '$1')
    .replace(BEARER_RE, 'Bearer <скрыто>')
    .replace(SECRET_RE, '<ключ скрыт>')
    .replace(LONG_HEX_RE, '<hex>');
  return redactPII(t).slice(0, max);
}

/** Путь без query и фрагмента: в них бывают ключи (/request-status#<ключ>) и ПД. */
export function pathOnly(raw: string | null | undefined): string {
  let p = String(raw ?? '');
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { p = '/'; }
  }
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith('/')) p = '/';
  return p.slice(0, 500);
}

/**
 * Отпечаток группы: род, сообщение без чисел, первый кадр стека без адреса
 * файла (имена чанков Next несут хэш сборки, строки и колонки — позицию;
 * и то и другое меняется от сборки к сборке, а ошибка та же). Одна ошибка у
 * ста человек и в трёх сборках — одна группа в переписи.
 */
export function errorFingerprint(kind: string, message: string, stack: string | null | undefined): string {
  const norm = (s: string) => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const firstFrame = ((stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^at\s|@/.test(l)) ?? '')
    .replace(/\s*\(.*$/, '')
    .replace(/\s+(?:https?:\/\/|\/)\S*$/, '');
  const basis = `${kind}|${norm(message).slice(0, 200)}|${norm(firstFrame).slice(0, 200)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export type Device = 'phone' | 'tablet' | 'desktop' | 'unknown';
export type Browser = 'chrome' | 'safari' | 'firefox' | 'yandex' | 'edge' | 'samsung' | 'opera' | 'other';

/** Род устройства и браузера одним словом — строка User-Agent не хранится. */
export function classifyUserAgent(ua: string | null | undefined): { device: Device; browser: Browser } {
  const s = (ua ?? '').toLowerCase();
  if (!s) return { device: 'unknown', browser: 'other' };
  const device: Device = /ipad|tablet|android(?!.*mobile)/.test(s) ? 'tablet'
    : /mobile|iphone|android|ipod/.test(s) ? 'phone'
    : 'desktop';
  const browser: Browser = /yabrowser/.test(s) ? 'yandex'
    : /edg\//.test(s) ? 'edge'
    : /samsungbrowser/.test(s) ? 'samsung'
    : /opr\/|opera/.test(s) ? 'opera'
    : /firefox|fxios/.test(s) ? 'firefox'
    : /chrome|crios/.test(s) ? 'chrome'
    : /safari/.test(s) ? 'safari'
    : 'other';
  return { device, browser };
}
