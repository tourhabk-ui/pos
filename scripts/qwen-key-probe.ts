/**
 * Проба ключа Qwen с раннера (25.09): где его принимают и какого он рода.
 *
 * Владелец купил тарифный план Token в QwenCloud, выпустил новый ключ и
 * поставил его и на прод, и в секреты GitHub. Прод с ним получает 401
 * invalid_api_key на международном шлюзе — на всех моделях, включая зрение.
 * Ждать пересборки прода, чтобы узнать, тот ли это ключ и где он живёт,
 * незачем: тот же ключ лежит в секрете, и раннер спрашивает сам.
 *
 * Только чтение: список моделей и один токен на модель плана. Ключ наружу не
 * выходит — длина, отпечаток (8 hex SHA-256) и публичный префикс.
 *
 *   DASHSCOPE_API_KEY=... npx tsx scripts/qwen-key-probe.ts
 */
import { keyIdentity } from '@/lib/ai/key-identity';

const BASES = {
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
} as const;

/** Модели из списка «Поддерживаемые модели» плана на скрине владельца. */
const PLAN_MODELS = ['qwen3.8-flash', 'qwen3.8-max'];

function short(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

async function main(): Promise<number> {
  const raw = (process.env.DASHSCOPE_API_KEY ?? '').trim();
  const id = keyIdentity(raw);
  if (!id.present) { console.log('Ключа нет в секрете DASHSCOPE_API_KEY.'); return 2; }
  // Префикс плана (sk-sp-) — публичный маркер рода ключа, секрета в нём нет.
  const kind = raw.startsWith('sk-sp-') ? 'sk-sp- (ключ плана)' : raw.startsWith('sk-') ? 'sk- (обычный ключ)' : 'иной префикс';
  console.log(`ключ: длина ${id.length}, отпечаток ${id.fingerprint}, род ${kind}`);

  let anyOk = false;
  for (const [region, base] of Object.entries(BASES)) {
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${raw}` }, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      let count: number | null = null;
      try { const j = JSON.parse(body) as { data?: unknown[] }; count = Array.isArray(j.data) ? j.data.length : null; } catch { /* не JSON */ }
      console.log(`${region}: /models → HTTP ${res.status}${count !== null ? `, моделей ${count}` : ''}${res.ok ? '' : ` — ${short(body)}`}`);
      if (!res.ok) continue;
      for (const model of PLAN_MODELS) {
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw}` },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(30_000),
        });
        const b = await r.text();
        console.log(`  ${region} ${model}: HTTP ${r.status}${r.ok ? ' — отвечает' : ` — ${short(b)}`}`);
        if (r.ok) anyOk = true;
      }
    } catch (err) {
      // Сеть не дошла — «не смог», а не «ключ плохой» (§4.0).
      console.log(`${region}: сеть не дошла — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(anyOk ? 'ИТОГ: ключ рабочий хотя бы в одном регионе.' : 'ИТОГ: ни в одном регионе обычного шлюза ключ не отвечает.');
  return 0;
}

main().then((c) => process.exit(c));
