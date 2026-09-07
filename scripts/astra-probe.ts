/**
 * scripts/astra-probe.ts — очная ставка моделей на НАШЕЙ работе.
 *
 * Повод: владелец 07.09 — «astra доступна через опенроутер на гитхабе, давай
 * протестим». Проба каталога (openrouter-models.yml, прогон 1) показала, что
 * `openai/gpt-6-astra` существует; существование — ещё не пригодность.
 *
 * ── Чем эта проба отличается от «спросить модель, как дела» ────────────────
 *
 * Она гоняет ТОТ САМЫЙ промпт, которым Editor пишет описания на проде
 * (`buildDescriptionMessages`), и разбирает ответ ТЕМ ЖЕ разбором
 * (`pickDescriptionFromAnswer`). Своя игрушечная задача мерила бы не то, что
 * модель будет делать у нас: у Editor'а жёсткое требование — писать только из
 * переданных фактов, и именно на нём модели расходятся.
 *
 * Факты для пробы взяты из справочника вручную и НЕ содержат персональных
 * данных: маршрут, координаты, рельеф, опасности (D1-гард, §8).
 *
 * ── Цена не выдумывается ───────────────────────────────────────────────────
 *
 * Стоимость считается из `usage` ответа и цены из /models В ЭТОМ ЖЕ прогоне,
 * а не из памяти о прайсе. Рублёвая цифра — по коэффициенту §8 (×135), и она
 * названа оценкой, потому что коэффициент наш, а не OpenRouter'а.
 *
 * Использование: npx tsx scripts/astra-probe.ts <модель> [<модель> ...]
 */
import {
  buildDescriptionMessages,
  pickDescriptionFromAnswer,
  MIN_GENERATION_LENGTH,
  type RouteRow,
} from '../lib/agents/editor';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const RUB_PER_USD = 135; // §8: цена каталога Timeweb = долларовый прайс × 135

/**
 * Настоящая запись из справочника, у которой описания нет. Факты полные —
 * значит модели нечем оправдать выдумку, и видно, выдумывает ли она.
 */
const ROUTE: RouteRow = {
  id: '00000000-0000-0000-0000-000000000000',
  title: 'Вулкан Горелый',
  description: null,
  category: null,
  kind: 'route',
  lat: 52.558, lng: 158.03,
  location_type: 'volcano',
  activity_type: 'hiking',
  zone: 'avachinsky',
  source_name: 'visitkamchatka.ru',
  altitude_m: 1829,
  terrain_type: 'вулканический шлак, лавовые поля',
  hazard_types: ['вулканические газы', 'резкая смена погоды'],
  difficulty_level: 'medium',
  nearest_medical_km: 75,
  distance_km: 12.5,
  elevation_gain_m: 850,
  duration_hours: 7,
  season: 'summer',
  route_type: 'радиальный',
  hazards: ['сернистые газы в кратере', 'камнепад на кромке'],
  equipment: ['треккинговые ботинки', 'ветрозащита', 'вода 2 л'],
  park_name: 'Природный парк «Южно-Камчатский»',
};

interface Pricing { prompt: number; completion: number }

async function catalogPrice(key: string, model: string): Promise<Pricing | null> {
  try {
    const res = await fetch(`${OPENROUTER}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
    const hit = (data.data ?? []).find((m) => m.id === model);
    if (!hit?.pricing) return null;
    const prompt = Number(hit.pricing.prompt);
    const completion = Number(hit.pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return { prompt, completion };
  } catch {
    return null;
  }
}

interface Answer {
  text: string | null;
  error: string | null;
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

async function ask(key: string, model: string): Promise<Answer> {
  const messages = buildDescriptionMessages(ROUTE);
  const started = Date.now();
  try {
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'TourHab model probe (runner)',
      },
      body: JSON.stringify({ model, messages, max_tokens: 1600, temperature: 0.5 }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text();
      return { text: null, error: `HTTP ${res.status}: ${body.slice(0, 300)}`, ms, promptTokens: null, completionTokens: null };
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? null;
    return {
      text,
      error: text ? null : 'ответ без содержимого',
      ms,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    };
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
      promptTokens: null,
      completionTokens: null,
    };
  }
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('OPENROUTER_API_KEY не задан — спросить некого. Это отказ пробы, а не приговор модели.');
    process.exit(1);
  }
  const models = process.argv.slice(2);
  if (models.length === 0) {
    console.error('Не названо ни одной модели.');
    process.exit(1);
  }

  let answered = 0;
  for (const model of models) {
    console.log(`\n${'='.repeat(72)}\nМОДЕЛЬ: ${model}`);
    const [price, answer] = await Promise.all([catalogPrice(key, model), ask(key, model)]);

    if (!answer.text) {
      // Молчание — это исход, и он называется вслух (§4.0).
      console.log(`  НЕ ОТВЕТИЛА за ${answer.ms} мс. Причина: ${answer.error ?? 'не записана'}`);
      continue;
    }
    answered += 1;

    const verdict = pickDescriptionFromAnswer(answer.text);
    const accepted = verdict.text !== null;
    console.log(`  ответ за ${answer.ms} мс, токенов: вход ${answer.promptTokens ?? '?'} / выход ${answer.completionTokens ?? '?'}`);

    if (price && answer.promptTokens !== null && answer.completionTokens !== null) {
      const usd = answer.promptTokens * price.prompt + answer.completionTokens * price.completion;
      console.log(`  цена вызова: $${usd.toFixed(5)} (~${(usd * RUB_PER_USD).toFixed(2)} ₽ по коэффициенту §8, оценка)`);
      const per1000 = usd * 1000;
      console.log(`  тысяча таких описаний: $${per1000.toFixed(2)} (~${(per1000 * RUB_PER_USD).toFixed(0)} ₽, оценка)`);
    } else {
      console.log('  цену посчитать не смогли: каталог или usage не дали цифр');
    }

    console.log(`  разбор Editor'а: ${accepted ? 'ПРИНЯТО' : `ОТКЛОНЕНО (${verdict.failReason ?? 'причина не записана'})`}`);
    const shown = verdict.text ?? answer.text;
    console.log(`  длина: ${shown.length} симв. (порог Editor'а — ${MIN_GENERATION_LENGTH})`);
    console.log('  --- текст ---');
    console.log(shown.split('\n').map((line: string) => `  ${line}`).join('\n'));
  }

  console.log(`\n${'='.repeat(72)}`);
  if (answered === 0) {
    console.error('Ни одна модель не ответила — прогон красный: сравнивать нечего.');
    process.exit(1);
  }
  console.log(`Ответили ${answered} из ${models.length}.`);
}

void main();
