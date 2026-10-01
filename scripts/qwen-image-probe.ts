/**
 * Проба генерации картинки на DashScope с раннера (01.10).
 *
 * На проде QWEN_IMAGE_MODEL=qwen-image (timeweb-app-info, прогон 2), а Alibaba
 * отключает её 10.10.2026; замена по уведомлению id=2009 — qwen-image-3.0.
 * Вопрос не «есть ли модель в каталоге», а «рисует ли она тем путём, которым
 * зовёт код»: обложки постов и картинки мест (lib/notifications/cover-image)
 * создают задачу асинхронно через text2image/image-synthesis и опрашивают её.
 * Модель, рисующая только синхронным multimodal-generation, по этому пути
 * откажет — и откажет молча, уйдя на Pollinations. Поэтому каждый id
 * спрашивается ОБОИМИ путями, и исход у каждого назван отдельно.
 *
 * Тратит не больше четырёх картинок (две модели × два пути). В режиме «только
 * бесплатная квота» платный вызов невозможен — шлюз отвечает 403, а не
 * списывает. Ключ наружу не выходит; URL картинки не печатается (он
 * подписан и временный) — только факт, что он есть.
 *
 *   DASHSCOPE_API_KEY=... npx tsx scripts/qwen-image-probe.ts
 */

// Модуль, а не глобальный скрипт: без import/export его main столкнулся бы
// с main соседних скриптов в общей проверке типов.
export {};

const BASE = 'https://dashscope-intl.aliyuncs.com';
const MODELS = ['qwen-image', 'qwen-image-3.0'];
const PROMPT = 'Kamchatka volcano at sunrise over the ocean, wild nature, cinematic landscape photograph, no text';
/** Размер — тот же, что у кода обложек по умолчанию (QWEN_IMAGE_SIZE). */
const SIZE = '1280*720';

function short(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 220);
}

function errCode(body: string): string {
  return body.match(/"code"\s*:\s*"([^"]{1,60})"/)?.[1] ?? '';
}

/** Путь кода обложек: асинхронная задача + опрос. */
async function viaAsyncTask(key: string, model: string): Promise<string> {
  const started = Date.now();
  let taskId: string | null = null;
  try {
    const r = await fetch(`${BASE}/api/v1/services/aigc/text2image/image-synthesis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model, input: { prompt: PROMPT }, parameters: { size: SIZE, n: 1 } }),
      signal: AbortSignal.timeout(20_000),
    });
    const b = await r.text();
    if (!r.ok) return `создание задачи — HTTP ${r.status} ${errCode(b)} — ${short(b)}`;
    taskId = (JSON.parse(b) as { output?: { task_id?: string } }).output?.task_id ?? null;
    if (!taskId) return `создание задачи — HTTP 200 без task_id — ${short(b)}`;
  } catch (err) {
    return `сеть не дошла — ${err instanceof Error ? err.message : String(err)}`;
  }

  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));
    try {
      const r = await fetch(`${BASE}/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      const b = await r.text();
      if (!r.ok) { last = `опрос HTTP ${r.status}`; continue; }
      const out = (JSON.parse(b) as { output?: { task_status?: string; results?: Array<{ url?: string }>; code?: string; message?: string } }).output;
      const status = out?.task_status ?? '?';
      last = status;
      if (status === 'SUCCEEDED') {
        const has = Boolean(out?.results?.some((x) => typeof x.url === 'string' && x.url.length > 0));
        return has ? `РИСУЕТ (${Math.round((Date.now() - started) / 1000)} с)` : 'SUCCEEDED, но URL картинки нет';
      }
      if (status === 'FAILED' || status === 'UNKNOWN') return `задача ${status} — ${out?.code ?? ''} ${short(out?.message ?? '')}`;
    } catch (err) {
      last = `опрос: сеть — ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Не дождались — «не знаем», а не «не рисует» (§4.0).
  return `не дождались за 90 с (последний статус: ${last || '—'})`;
}

/** Синхронный путь, который Alibaba документирует для семейства qwen-image. */
async function viaMultimodal(key: string, model: string): Promise<string> {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: PROMPT }] }] },
        parameters: { size: SIZE },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const b = await r.text();
    if (!r.ok) return `HTTP ${r.status} ${errCode(b)} — ${short(b)}`;
    const has = /"image"\s*:\s*"https?:\/\//.test(b);
    return has ? `РИСУЕТ (${Math.round((Date.now() - started) / 1000)} с)` : `HTTP 200 без картинки — ${short(b)}`;
  } catch (err) {
    return `сеть не дошла — ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<number> {
  const key = (process.env.DASHSCOPE_API_KEY ?? '').trim();
  if (!key) { console.log('Ключа нет в секрете DASHSCOPE_API_KEY.'); return 2; }

  // Каталог OpenAI-совместимого шлюза картинки обычно не перечисляет — печатаем
  // то, что есть, только для сведения.
  try {
    const r = await fetch(`${BASE}/compatible-mode/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    const img = ids.filter((m) => /image|wan|t2i/i.test(m)).sort();
    console.log(`каталог: моделей ${ids.length}, похожих на картинки ${img.length}: ${img.join(', ') || 'нет'}`);
  } catch (err) {
    console.log(`каталог не прочитан — ${err instanceof Error ? err.message : String(err)}`);
  }

  let drawn = 0;
  for (const model of MODELS) {
    const a = await viaAsyncTask(key, model);
    console.log(`${model} · путь кода (text2image, задача): ${a}`);
    const m = await viaMultimodal(key, model);
    console.log(`${model} · multimodal-generation: ${m}`);
    if (a.startsWith('РИСУЕТ')) drawn += 1;
  }
  console.log(`ИТОГ: путём кода рисуют ${drawn} из ${MODELS.length}.`);
  return 0;
}

main().then((c) => process.exit(c));
