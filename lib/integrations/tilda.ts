/**
 * Tilda Export API от имени партнёра.
 *
 * Ключи — в partner_integrations (provider 'tilda'), НЕ в env и НЕ в коде:
 * партнёров много, у каждого свои ключи (решение владельца 06.08). Репозиторий
 * публичный — ключ в коде был бы мгновенным сливом.
 *
 * API Tilda только читает: списки проектов и страниц, контент, экспорт.
 * Писать (менять H1, добавлять разметку, создавать страницы) через него
 * нельзя вовсе — правки только руками в панели Tilda. Лимит: 150 запросов/час.
 *
 * Вызовы идут с прода (RF-хостинг): из песочниц и через зарубежные IP
 * api.tildacdn.info отвечает 403.
 */

import { pool } from '@/lib/db-pool';

const TILDA_API = 'https://api.tildacdn.info/v1';

export interface TildaCredentials {
  public_key: string;
  secret_key: string;
}

/** Ключ наружу — только хвост: «····f1a2». Целиком не показываем даже админу. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '····';
  return `····${key.slice(-4)}`;
}

export async function getTildaCredentials(partnerId: string): Promise<TildaCredentials | null> {
  const { rows } = await pool.query<{ credentials: Record<string, unknown> }>(
    `SELECT credentials FROM partner_integrations
      WHERE partner_id = $1 AND provider = 'tilda'`,
    [partnerId],
  );
  const c = rows[0]?.credentials;
  if (!c || typeof c.public_key !== 'string' || typeof c.secret_key !== 'string') return null;
  return { public_key: c.public_key, secret_key: c.secret_key };
}

export async function saveTildaCredentials(partnerId: string, creds: TildaCredentials): Promise<void> {
  await pool.query(
    `INSERT INTO partner_integrations (partner_id, provider, credentials)
     VALUES ($1, 'tilda', $2::jsonb)
     ON CONFLICT (partner_id, provider)
     DO UPDATE SET credentials = EXCLUDED.credentials, updated_at = NOW()`,
    [partnerId, JSON.stringify(creds)],
  );
}

export async function deleteTildaCredentials(partnerId: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM partner_integrations WHERE partner_id = $1 AND provider = 'tilda'`,
    [partnerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Вызов метода Tilda API. Ответ читается текстом до разбора: не-JSON ответ
 * (HTML заглушки, лимит запросов) не прячет причину — урок MAX-канала.
 */
export async function tildaCall<T>(
  method: 'getprojectslist' | 'getproject' | 'getpageslist' | 'getpage' | 'getpagefull',
  params: Record<string, string>,
  creds: TildaCredentials,
): Promise<T> {
  const qs = new URLSearchParams({
    publickey: creds.public_key,
    secretkey: creds.secret_key,
    ...params,
  });
  const res = await fetch(`${TILDA_API}/${method}/?${qs.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tilda API ${method}: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Tilda API ${method}: не-JSON ответ — ${text.slice(0, 300)}`);
  }
  const obj = json as { status?: string; result?: T; message?: string };
  if (obj.status !== 'FOUND') {
    throw new Error(`Tilda API ${method}: ${obj.message ?? obj.status ?? 'пустой ответ'}`);
  }
  return obj.result as T;
}

export interface TildaProject {
  id: string;
  title: string;
  descr?: string;
}

export interface TildaPage {
  id: string;
  projectid: string;
  title: string;
  descr?: string;
  alias?: string;
  date?: string;
  published?: string;
  filename?: string;
}
