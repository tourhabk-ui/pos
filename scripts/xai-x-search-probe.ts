/**
 * Проба с раннера (29.09): умеет ли наш ключ xAI читать посты X через
 * серверный инструмент поиска — и почём.
 *
 * Повод — решение владельца: «разведчик должен читать новости про ИИ в X,
 * может добавим Grok». Из контейнера разработки закрыты и docs.x.ai, и
 * api.x.ai, а параметры инструмента и его цена по памяти — это «объявленный
 * исход без источника» (§4). Проба отвечает фактами: ответом API и строками
 * прайса с самой документации.
 *
 * Только чтение. Ключ наружу не выходит — длина и отпечаток. Ничего не
 * пишет ни в БД, ни в репозиторий. Два способа, потому что xAI менял API:
 *   A. Responses API + инструмент `x_search` (новый агентный путь);
 *   B. chat/completions + `search_parameters` с источником `x` (прежний
 *      Live Search) — на случай, если A у нашего ключа/модели не принят.
 * Что из этого ответило — печатается; что не ответило — с кодом и телом.
 *
 *   XAI_API_KEY=... npx tsx scripts/xai-x-search-probe.ts
 */
import { keyIdentity } from '@/lib/ai/key-identity';
import { stripTags } from '@/lib/html/text';

const BASE = 'https://api.x.ai/v1';
const DOCS = [
  'https://docs.x.ai/docs/guides/tools/x-search',
  'https://docs.x.ai/docs/guides/tools/overview',
  'https://docs.x.ai/docs/models',
];

/**
 * Параметры пробы приходят через env (workflow разбирает маркер JSON сам):
 * CodeQL считает данные из файла в теле сетевого запроса находкой
 * (js/file-access-to-http), а маркер — это конфиг из репозитория, не ввод.
 * Форма значений при этом проверяется: аккаунт X — до 15 знаков [A-Za-z0-9_].
 */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function envList(name: string, re: RegExp): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^@/, ''))
    .filter((x) => x.length > 0 && re.test(x));
}

function short(s: string, n = 400): string {
  return s.replace(/\s+/g, ' ').slice(0, n);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getJson(url: string, key: string, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
}

async function postJson(url: string, key: string, payload: unknown, timeoutMs = 120_000): Promise<{ status: number; body: string; ms: number }> {
  const started = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, body: await r.text(), ms: Date.now() - started };
}

/** Собрать текст и служебные элементы из ответа Responses API — по форме, без догадок о схеме. */
function digestResponses(j: unknown): { text: string; itemTypes: string[]; usage: unknown } {
  const o = (j ?? {}) as { output?: unknown; usage?: unknown; output_text?: unknown };
  const items = Array.isArray(o.output) ? o.output : [];
  const itemTypes: string[] = [];
  let text = typeof o.output_text === 'string' ? o.output_text : '';
  for (const it of items) {
    const item = it as { type?: unknown; content?: unknown };
    if (typeof item.type === 'string') itemTypes.push(item.type);
    if (Array.isArray(item.content)) {
      for (const c of item.content) {
        const part = c as { type?: unknown; text?: unknown };
        if (typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
      }
    }
  }
  return { text, itemTypes, usage: o.usage ?? null };
}

function digestChat(j: unknown): { text: string; citations: unknown; usage: unknown } {
  const o = (j ?? {}) as { choices?: Array<{ message?: { content?: unknown } }>; citations?: unknown; usage?: unknown };
  const content = o.choices?.[0]?.message?.content;
  return { text: typeof content === 'string' ? content : '', citations: o.citations ?? null, usage: o.usage ?? null };
}

async function docsPriceLines(): Promise<void> {
  console.log('\n== Документация xAI: строки с ценой и параметрами (как есть, с сайта) ==');
  for (const url of DOCS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VedarProbe/1.0)' } });
      const html = await r.text();
      // Одна реализация снятия разметки на репозиторий (lib/html/text):
      // тело скрипта не остаётся, снятие до неподвижной точки.
      const text = stripTags(html, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
      console.log(`\n-- ${url} → HTTP ${r.status}, ${text.length} знаков текста`);
      const hits = text.match(/[^.]{0,120}(\$\s?\d[\d.,]*|per 1[,\d]* |allowed_x_handles|from_date|to_date|x_search|search_parameters|tool call)[^.]{0,160}/gi) ?? [];
      const uniq = [...new Set(hits.map((h) => h.trim()))].slice(0, 30);
      if (uniq.length === 0) console.log('   совпадений по цене/параметрам нет (страница могла уехать или отдаётся скриптом)');
      for (const h of uniq) console.log(`   · ${h}`);
    } catch (err) {
      console.log(`\n-- ${url}: сеть не дошла — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<number> {
  const raw = (process.env.XAI_API_KEY ?? '').trim();
  const id = keyIdentity(raw);
  if (!id.present) { console.log('Ключа нет в секрете XAI_API_KEY.'); return 2; }
  console.log(`ключ: длина ${id.length}, отпечаток ${id.fingerprint}, префикс ${raw.startsWith('xai-') ? 'xai-' : 'иной'}`);

  const fromEnv = envList('PROBE_HANDLES', HANDLE_RE);
  const handles = fromEnv.length > 0 ? fromEnv : ['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'xai', 'huggingface', 'MistralAI'];
  const hoursRaw = Number(process.env.PROBE_HOURS);
  const hours = Number.isFinite(hoursRaw) && hoursRaw >= 1 && hoursRaw <= 168 ? Math.floor(hoursRaw) : 24;
  const modelsFromEnv = envList('PROBE_MODELS', MODEL_RE);
  const maxRaw = Number(process.env.PROBE_MAX_MODELS);
  const maxModels = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 10 ? Math.floor(maxRaw) : 3;
  const run = process.env.PROBE_RUN ?? '?';
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  console.log(`прогон ${run}: аккаунты ${handles.map((h) => '@' + h).join(', ')}; окно ${hours} ч (${isoDate(from)} … ${isoDate(to)})`);

  // Каталог — правда о том, какие модели есть у ключа сегодня.
  let catalog: string[] = [];
  const models = await getJson(`${BASE}/models`, raw).catch((err) => ({ status: 0, body: String(err) }));
  if (models.status === 200) {
    try {
      const j = JSON.parse(models.body) as { data?: Array<{ id?: unknown }> };
      catalog = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    } catch { /* тело не JSON — ниже напечатаем */ }
    console.log(`/models → HTTP 200, моделей ${catalog.length}: ${catalog.join(', ')}`);
  } else {
    console.log(`/models → HTTP ${models.status} — ${short(models.body)}`);
  }

  const wanted = modelsFromEnv.length > 0
    ? modelsFromEnv
    : catalog.filter((m) => /grok/i.test(m) && !/(image|vision|voice|audio|imagegen)/i.test(m)).slice(0, maxModels);
  if (wanted.length === 0) {
    console.log('ИТОГ: моделей для пробы нет — каталог не прочитан и список PROBE_MODELS пуст.');
    await docsPriceLines();
    return 1;
  }

  const prompt =
    `Найди посты за последние ${hours} часов от аккаунтов ${handles.map((h) => '@' + h).join(', ')} ` +
    'о новостях и релизах в области ИИ. Верни ТОЛЬКО JSON-массив объектов вида ' +
    '{"handle":"…","url":"…","posted_at":"…","summary_ru":"…до 200 знаков…"}. ' +
    'Ничего не выдумывай: если постов за окно нет — верни пустой массив [].';

  let answered = 0;
  for (const model of wanted) {
    console.log(`\n== ${model} ==`);

    // A. Responses API + x_search
    const a = await postJson(`${BASE}/responses`, raw, {
      model,
      input: [{ role: 'user', content: prompt }],
      tools: [{ type: 'x_search', allowed_x_handles: handles, from_date: isoDate(from), to_date: isoDate(to) }],
      max_output_tokens: 1500,
    }).catch((err) => ({ status: 0, body: String(err), ms: 0 }));
    console.log(`A. /responses + x_search → HTTP ${a.status} за ${a.ms} мс`);
    if (a.status === 200) {
      answered += 1;
      let d: ReturnType<typeof digestResponses> | null = null;
      try { d = digestResponses(JSON.parse(a.body)); } catch { /* ниже — сырое тело */ }
      if (d) {
        console.log(`   элементы ответа: ${d.itemTypes.join(', ') || '—'}`);
        console.log(`   usage: ${JSON.stringify(d.usage)}`);
        console.log(`   текст (${d.text.length} знаков):\n${d.text.slice(0, 3000)}`);
      } else {
        console.log(`   тело не разобрано: ${short(a.body, 1500)}`);
      }
    } else {
      console.log(`   ${short(a.body, 600)}`);
    }

    // B. chat/completions + search_parameters (прежний Live Search)
    const b = await postJson(`${BASE}/chat/completions`, raw, {
      model,
      messages: [{ role: 'user', content: prompt }],
      search_parameters: {
        mode: 'on',
        sources: [{ type: 'x', x_handles: handles }],
        from_date: isoDate(from),
        to_date: isoDate(to),
        return_citations: true,
        max_search_results: 20,
      },
      max_tokens: 1500,
    }).catch((err) => ({ status: 0, body: String(err), ms: 0 }));
    console.log(`B. /chat/completions + search_parameters → HTTP ${b.status} за ${b.ms} мс`);
    if (b.status === 200) {
      answered += 1;
      let d: ReturnType<typeof digestChat> | null = null;
      try { d = digestChat(JSON.parse(b.body)); } catch { /* ниже — сырое тело */ }
      if (d) {
        console.log(`   usage: ${JSON.stringify(d.usage)}`);
        console.log(`   citations: ${JSON.stringify(d.citations)?.slice(0, 1500)}`);
        console.log(`   текст (${d.text.length} знаков):\n${d.text.slice(0, 3000)}`);
      } else {
        console.log(`   тело не разобрано: ${short(b.body, 1500)}`);
      }
    } else {
      console.log(`   ${short(b.body, 600)}`);
    }
  }

  await docsPriceLines();

  // Ни один путь не ответил — отказ пробы, а не «X недоступен» (§4.0):
  // причина в строках выше (ключ, модель, форма запроса).
  if (answered === 0) { console.log('\nИТОГ: ни один путь не ответил 200.'); return 1; }
  console.log(`\nИТОГ: ответили ${answered} запросов из ${wanted.length * 2}.`);
  return 0;
}

main().then((c) => process.exit(c));
