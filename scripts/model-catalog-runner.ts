/**
 * scripts/model-catalog-runner.ts
 *
 * Привозит каталог моделей с ценами на прод.
 *
 * Прод спросить не может: OpenRouter отвечает ему 403 и напрямую, и через
 * релей (замер 07.09). Раннер GitHub не в РФ и каталог видит — тот же приём,
 * что у разбора находок, AI-ревью и Editor'а.
 *
 * Отличие от `openrouter-models.yml`: тот ПЕЧАТАЕТ ответ на разовый вопрос
 * («есть ли такая модель и почём»), этот КЛАДЁТ весь каталог в базу, чтобы
 * админка показывала цены без запроса наружу. Одна и та же публичная ручка,
 * два разных потребителя; сливать их в один файл значило бы, что разовый
 * вопрос по маркеру каждый раз переписывает боевые данные.
 *
 * Только чтение каталога: ни одного запроса к модели, ни рубля расхода.
 */

import { parseCatalogPrice } from '../lib/ai/model-cost';

const CATALOG = 'https://openrouter.ai/api/v1/models';

interface CatalogModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: unknown; completion?: unknown };
}

async function main(): Promise<void> {
  const key = (process.env.OPENROUTER_API_KEY ?? '').trim();
  const base = (process.env.PROD_BASE ?? 'https://vedarai.ru').replace(/\/+$/, '');
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();

  if (!key) throw new Error('OPENROUTER_API_KEY не задан — каталог не спрошен');
  if (!cronSecret) throw new Error('CRON_SECRET не задан — везти каталог некуда');

  const res = await fetch(CATALOG, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Каталог не отдан: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: CatalogModel[] };
  const raw = data?.data ?? [];

  // Ноль моделей при живом HTTP 200 — отказ, а не пустой каталог (§4.0).
  // Прод такую партию тоже не примет, но краснеть должен и прогон: иначе в
  // журнале Actions это выглядит успехом.
  if (raw.length === 0) {
    throw new Error('Каталог вернул ноль моделей — это отказ, а не пустой каталог');
  }

  const models = raw
    .filter((entry): entry is CatalogModel & { id: string } => typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 300) : null,
      // Цена разбирается ОБЩЕЙ функцией: «нет цены», «ноль» и «мусор» —
      // разные состояния, и склеить их по дороге нельзя.
      usd_per_mtok_in: parseCatalogPrice(entry.pricing?.prompt),
      usd_per_mtok_out: parseCatalogPrice(entry.pricing?.completion),
      context_length:
        typeof entry.context_length === 'number' && Number.isFinite(entry.context_length) && entry.context_length > 0
          ? Math.round(entry.context_length)
          : null,
    }));

  const priced = models.filter((x) => x.usd_per_mtok_in !== null).length;
  console.log(`каталог: ${models.length} моделей, с ценой входа ${priced}`);

  const post = await fetch(`${base}/api/cron/model-catalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cronSecret}` },
    body: JSON.stringify({ source: 'openrouter', fetched_at: new Date().toISOString(), models }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await post.text().catch(() => '');
  if (!post.ok) {
    throw new Error(`Прод не принял каталог: HTTP ${post.status} ${body.slice(0, 300)}`);
  }
  console.log(`прод принял: ${body.slice(0, 200)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
