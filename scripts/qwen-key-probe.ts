/**
 * Проба ключа Qwen с раннера (25.09): где его принимают и какие модели на нём
 * ОТВЕЧАЮТ.
 *
 * Прогон 1: владелец выпустил новый ключ; вопрос был, тот ли он и где живёт.
 * Прогон 2: владелец решил остаться на бесплатной квоте («работаем на
 * бесплатной»). Квоты у DashScope считаются ПО МОДЕЛЯМ раздельно, и у
 * qwen-plus она кончилась (403 AllocationQuota.FreeTierOnly), а у других ещё
 * есть. Значит вопрос не «работает ли ключ», а «на каких моделях» — и отвечать
 * на него надо запросом, а не чтением страницы квот: 25.09 страница показывала
 * qwen3.8-max с 78.5% остатка, а прод получал от неё FreeTierOnly.
 *
 * Только чтение: список моделей и один токен на модель. В режиме «только
 * бесплатная квота» платный вызов невозможен — шлюз отвечает 403, а не
 * списывает. Ключ наружу не выходит — длина, отпечаток (8 hex SHA-256) и
 * публичный префикс.
 *
 *   DASHSCOPE_API_KEY=... npx tsx scripts/qwen-key-probe.ts
 */
import { keyIdentity } from '@/lib/ai/key-identity';
import { classifyModels } from '@/lib/ai/model-resolver';

const BASES = {
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
} as const;

/** Что зовёт код сегодня: дефолт цикла инструментов и зрение. */
const ALWAYS = ['qwen-plus', 'qwen-vl-max'];
/** Сколько сильнейших текстовых моделей каталога опрашивать. */
const TOP_N = 25;

function short(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 200);
}

async function ping(base: string, key: string, model: string): Promise<string> {
  const started = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const b = await r.text();
    const ms = Date.now() - started;
    if (r.ok) return `ОТВЕЧАЕТ (${ms} мс)`;
    const code = b.match(/"code"\s*:\s*"([^"]{1,60})"/)?.[1] ?? '';
    return `HTTP ${r.status} ${code} — ${short(b)}`;
  } catch (err) {
    // Сеть не дошла — «не смог», а не «нет квоты» (§4.0).
    return `сеть не дошла — ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<number> {
  const raw = (process.env.DASHSCOPE_API_KEY ?? '').trim();
  const id = keyIdentity(raw);
  if (!id.present) { console.log('Ключа нет в секрете DASHSCOPE_API_KEY.'); return 2; }
  // Префикс плана (sk-sp-) — публичный маркер рода ключа, секрета в нём нет.
  const kind = raw.startsWith('sk-sp-') ? 'sk-sp- (ключ плана)' : raw.startsWith('sk-') ? 'sk- (обычный ключ)' : 'иной префикс';
  console.log(`ключ: длина ${id.length}, отпечаток ${id.fingerprint}, род ${kind}`);

  let answering = 0;
  let asked = 0;
  for (const [region, base] of Object.entries(BASES)) {
    let ids: string[] = [];
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${raw}` }, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (!res.ok) { console.log(`${region}: /models → HTTP ${res.status} — ${short(body)}`); continue; }
      const j = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
      ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
      console.log(`${region}: /models → HTTP 200, моделей ${ids.length}`);
    } catch (err) {
      console.log(`${region}: сеть не дошла — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const top = classifyModels(ids).filter((m) => m.eligible).slice(0, TOP_N).map((m) => m.id);
    const models = [...new Set([...ALWAYS, ...top])];
    for (const model of models) {
      const verdict = await ping(base, raw, model);
      asked += 1;
      if (verdict.startsWith('ОТВЕЧАЕТ')) answering += 1;
      console.log(`  ${region} ${model}: ${verdict}`);
    }
  }
  // Ноль опрошенных — отказ пробы, а не «ни одна не отвечает» (§4.0).
  if (asked === 0) { console.log('ИТОГ: не опрошено ни одной модели — каталог не прочитан.'); return 1; }
  console.log(`ИТОГ: отвечают ${answering} из ${asked} опрошенных.`);
  return 0;
}

main().then((c) => process.exit(c));
