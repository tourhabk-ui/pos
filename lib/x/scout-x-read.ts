/**
 * Откуда разведчик берёт посты X (23.10): сначала X API ключом владельца
 * (lib/x/x-api-read), не вышло — запасной путь xAI `x_search`
 * (lib/ai/xai-x-search). Выбор здесь, а не в скрипте раннера: правило под
 * тестом, а скрипт только зовёт его и пишет файл.
 *
 * Запасной путь не молчит: когда посты пришли от xAI, причина, по которой
 * X API не ответил, стоит в `diag.fallbackFrom`; отказали оба — одна причина
 * из двух частей. «Ключ X не задан» — тоже причина, а не тишина.
 */
import { searchX, type XSearchResult } from '@/lib/ai/xai-x-search';
import { readXCredentials, readXViaApi, X_ENV_BEARER, X_ENV_KEY, X_ENV_SECRET } from '@/lib/x/x-api-read';

export interface ScoutXReadDeps {
  viaApi: (o: { handles: readonly string[]; hours: number; env: Record<string, string | undefined> }) => Promise<XSearchResult>;
  viaXai: (o: { handles: readonly string[]; hours: number }) => Promise<XSearchResult>;
  env: Record<string, string | undefined>;
}

function withFallbackNote(r: XSearchResult, from: string): XSearchResult {
  if (!r.ok) return r;
  return { ...r, diag: { ...(r.diag ?? { searchCalls: 0, requests: 0 }), source: 'xai', fallbackFrom: from } };
}

export async function readXForScout(
  opts: { handles: readonly string[]; hours: number },
  deps: ScoutXReadDeps = { viaApi: readXViaApi, viaXai: searchX, env: process.env },
): Promise<XSearchResult> {
  const creds = readXCredentials(deps.env);
  if (creds.kind === 'none') {
    const back = await deps.viaXai(opts);
    return withFallbackNote(back, `X API: ключ не задан (${X_ENV_BEARER} или ${X_ENV_KEY}+${X_ENV_SECRET})`);
  }
  const direct = await deps.viaApi({ ...opts, env: deps.env });
  if (direct.ok) return direct;
  const back = await deps.viaXai(opts);
  if (back.ok) return withFallbackNote(back, direct.reason);
  return { ok: false, reason: `${direct.reason}; запасной путь xAI: ${back.reason}`.slice(0, 300) };
}
