#!/usr/bin/env node
'use strict';

/**
 * scripts/list-ai-models.js
 *
 * Печатает ТОЧНЫЕ model-id, которые API реально принимает (поле `id` из
 * /v1/models), — чтобы не гадать по маркетинговым именам. Значение `id` ставится
 * в env: EVO_DECISION_MODEL (DeepSeek), EVO_DECISION_QWEN_MODEL (Qwen),
 * или в waterfall для флагманов (OpenRouter).
 *
 * Запуск на сервере Timeweb (ключи берутся из окружения приложения):
 *   node scripts/list-ai-models.js
 *   node scripts/list-ai-models.js qwen        # только один провайдер
 *   node scripts/list-ai-models.js --grep max  # фильтр по подстроке id
 *
 * Первый честный кирпич model-watcher'а: тот же список, что потом будет
 * ранжировать автопредложение «доступна новее модель».
 */

const ONLY = process.argv.slice(2).find((a) => !a.startsWith('--'));
const grepIdx = process.argv.indexOf('--grep');
const GREP = grepIdx !== -1 ? (process.argv[grepIdx + 1] || '').toLowerCase() : null;

const stripSlash = (u) => u.replace(/\/+$/, '');

const PROVIDERS = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/models',
    token: process.env.DEEPSEEK_API_KEY,
    tokenName: 'DEEPSEEK_API_KEY',
    envHint: 'EVO_DECISION_MODEL',
  },
  {
    key: 'qwen',
    name: 'Qwen (DashScope)',
    url: stripSlash(process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1') + '/models',
    token: process.env.QWEN_API_KEY,
    tokenName: 'QWEN_API_KEY',
    envHint: 'EVO_DECISION_QWEN_MODEL',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    url: stripSlash(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') + '/models',
    token: process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY,
    tokenName: 'OPENROUTER_API_KEY',
    envHint: 'waterfall (OR_MODELS)',
    note: 'из РФ гео-блок — задай OPENROUTER_BASE_URL на релей (infra/ai-relay), иначе недоступен',
  },
];

/** Цена за 1M токенов из per-token-строки OpenRouter (например "0.0000025" → 2.50). */
function per1M(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return (n * 1_000_000).toFixed(2);
}

async function listOne(p) {
  console.log(`\n=== ${p.name} ===`);
  if (!p.token) {
    console.log(`  (пропущено: не задан ${p.tokenName})`);
    return;
  }
  let res;
  try {
    res = await fetch(p.url, {
      headers: { Authorization: `Bearer ${p.token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.log(`  (недостижим: ${e && e.name === 'TimeoutError' ? 'таймаут' : String(e && e.message || e)})`);
    if (p.note) console.log(`  ${p.note}`);
    return;
  }
  if (!res.ok) {
    console.log(`  (ошибка HTTP ${res.status})`);
    if (res.status === 403 && p.note) console.log(`  ${p.note}`);
    return;
  }

  let data;
  try { data = await res.json(); } catch { console.log('  (ответ не JSON)'); return; }
  let models = Array.isArray(data && data.data) ? data.data : [];
  if (GREP) models = models.filter((m) => String(m.id || '').toLowerCase().includes(GREP));
  models.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (models.length === 0) { console.log('  (моделей не найдено)'); return; }

  for (const m of models) {
    let price = '';
    if (m.pricing && (m.pricing.prompt != null || m.pricing.completion != null)) {
      const inp = per1M(m.pricing.prompt);
      const out = per1M(m.pricing.completion);
      if (inp || out) price = `   $${inp || '?'} / $${out || '?'} за 1M`;
    }
    console.log(`  ${m.id}${price}`);
  }
  console.log(`  → нужный id вставь в env: ${p.envHint}`);
}

(async () => {
  const targets = ONLY ? PROVIDERS.filter((p) => p.key === ONLY.toLowerCase()) : PROVIDERS;
  if (targets.length === 0) {
    console.error(`Неизвестный провайдер "${ONLY}". Доступны: ${PROVIDERS.map((p) => p.key).join(', ')}`);
    process.exit(1);
  }
  console.log('Актуальные model-id провайдеров (поле id — точное значение для env):');
  for (const p of targets) {
    // Последовательно, чтобы вывод не мешался
    // eslint-disable-next-line no-await-in-loop
    await listOne(p);
  }
  console.log('');
})();
