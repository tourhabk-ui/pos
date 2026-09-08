/**
 * scripts/channel-identity-runner.ts — чей это канал, по его собственному
 * содержимому.
 *
 * ── Повод ──────────────────────────────────────────────────────────────────
 *
 * Подбор источников (source-discovery) нашёл живой канал `t.me/s/kammeteo` и
 * предположил, что это Камчатское УГМС. Перепись доказала, что канал жив, —
 * и ровно ничего про то, ЧЕЙ он. Внести лавинный бюллетень «неизвестно от
 * кого» в источники безопасности хуже, чем не внести никакого: турист поверит
 * подписи, а не нашей осторожности.
 *
 * ── Почему модель, и почему ей всё равно нельзя верить ─────────────────────
 *
 * Владелец: «выполняй или заставь астру». Опознание организации по стилю,
 * терминологии и самоназванию — работа для модели. Но спрашивать её ПО ПАМЯТИ
 * бессмысленно: про малоизвестный региональный канал она вспомнит что угодно,
 * и это будет звучать уверенно.
 *
 * Поэтому здесь она судит ТОЛЬКО скачанное: заголовок канала, описание и
 * тексты последних постов. А приговор проверяется детерминированно — улика
 * обязана дословно встречаться в скачанном тексте. Придуманная цитата
 * отбрасывается вместе с вердиктом, и это считается числом.
 *
 * Приём тот же, что у finding-guard в Growth Scan и у разбора справочника
 * маршрутов: модель предлагает, машина проверяет.
 *
 * Ничего не пишет: печатает вердикт и улику, решение за человеком.
 *
 * Использование: npx tsx scripts/channel-identity-runner.ts <канал> [модель]
 */
import { openRouterAttribution } from '../lib/ai/attribution';
import { lastTelegramPost } from './source-discovery-runner';
import { htmlToText } from '../lib/html/text';
import { decodeHtmlEntities } from '../lib/html/entities';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-6-astra';

/** Снятая со страницы фактура канала — только то, что реально прислал сервер. */
export interface ChannelContent {
  title: string | null;
  description: string | null;
  posts: string[];
  lastPost: string | null;
}

/**
 * Разбор чужого HTML — общий на весь репозиторий, своей регулярки здесь нет.
 *
 * Первая редакция этого файла сняла теги вручную, и оба сторожа поймали её по
 * делу: `html-text` (разбор один на всех — своя копия не знает про `</script >`
 * с пробелом и снятие в один проход) и `html-entities` (разворот `&amp;`
 * отдельной заменой даёт двойной разворот: `&amp;lt;` превращается в `<`).
 * Тридцать таких копий уже были написаны в этом репозитории до меня.
 */
function toText(s: string): string {
  return decodeHtmlEntities(htmlToText(s)).replace(/\s+/g, ' ').trim();
}

/** Разбор превью канала. Чистая: тестируется без сети. */
export function parseChannel(html: string, maxPosts = 15): ChannelContent {
  const title = /<div class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    ?? /<meta property="og:title" content="([^"]*)"/i.exec(html)?.[1]
    ?? null;
  const description = /<div class="tgme_channel_info_description"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    ?? /<meta property="og:description" content="([^"]*)"/i.exec(html)?.[1]
    ?? null;

  const posts = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map(m => toText(m[1]))
    .filter(t => t.length > 10)
    .slice(-maxPosts);

  return {
    title: title ? toText(title) : null,
    description: description ? toText(description) : null,
    posts,
    lastPost: lastTelegramPost(html),
  };
}

export interface Verdict {
  org?: string | null;
  confident?: boolean;
  evidence?: string;
  publishes_hazard?: boolean;
  note?: string;
}

/** Нормализация для сверки улики: регистр и пробелы не должны решать. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[«»"'`]/g, '').trim();
}

/**
 * Улика обязана дословно быть в скачанном тексте. Пересказ своими словами не
 * годится: он неотличим от выдумки, а проверяем мы именно её отсутствие.
 */
export function evidenceHolds(v: Verdict, content: ChannelContent): boolean {
  const ev = norm(String(v.evidence ?? ''));
  if (ev.length < 8) return false;
  const haystack = norm([content.title ?? '', content.description ?? '', ...content.posts].join(' \n '));
  return haystack.includes(ev);
}

const SYSTEM = `Ты определяешь, КОМУ принадлежит Telegram-канал, по его собственному содержимому.

Тебе дают заголовок канала, описание и тексты последних постов. Больше ничего у тебя нет, и догадываться по памяти ЗАПРЕЩЕНО: канал может быть малоизвестным, и уверенный вымысел здесь опаснее честного «не установлено».

Ответ — СТРОГО JSON:
{"org": "название организации или null", "confident": true|false, "evidence": "ДОСЛОВНАЯ цитата из присланного текста, подтверждающая вывод", "publishes_hazard": true|false, "note": "одна фраза"}

Правила:
- evidence — только дословный фрагмент присланного текста. Пересказ не принимается: он будет отброшен машинной сверкой, и вердикт вместе с ним.
- confident=false, если содержимое не позволяет назвать владельца. Это нормальный ответ, а не поражение.
- publishes_hazard=true, если канал публикует предупреждения об опасностях: лавины, штормы, метели, паводки, циклоны, ЧС.`;

async function main(): Promise<void> {
  const channel = (process.argv[2] || '').trim();
  if (!channel) {
    console.error('Не назван канал. Использование: npx tsx scripts/channel-identity-runner.ts <канал> [модель]');
    process.exit(1);
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('OPENROUTER_API_KEY не задан — судить нечем. Это не «канал не опознан».');
    process.exit(1);
  }
  const model = (process.argv[3] || '').trim() || DEFAULT_MODEL;

  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TourHab/1.0 (channel identity)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`Канал не прочитан: HTTP ${res.status}. Опознавать нечего.`);
    process.exit(1);
  }
  const content = parseChannel(await res.text());

  console.log(`Канал: ${url}`);
  console.log(`Заголовок: ${content.title ?? 'нет'}`);
  console.log(`Описание: ${content.description ?? 'нет'}`);
  console.log(`Последний пост: ${content.lastPost ?? 'без даты'}`);
  console.log(`Постов прочитано: ${content.posts.length}`);
  if (content.posts.length === 0) {
    console.error('Постов нет — судить не по чему.');
    process.exit(1);
  }
  console.log('\nПервые три поста для глаз человека:');
  for (const p of content.posts.slice(0, 3)) console.log(`  · ${p.slice(0, 200)}`);

  const user = [
    `Заголовок канала: ${content.title ?? 'не указан'}`,
    `Описание: ${content.description ?? 'не указано'}`,
    '',
    'Последние посты:',
    ...content.posts.map((p, i) => `${i + 1}. ${p.slice(0, 600)}`),
  ].join('\n');

  const r = await fetch(OPENROUTER, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...openRouterAttribution('channel-identity'),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    console.error(`OpenRouter ответил HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const json = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
  const answer = json.choices?.[0]?.message?.content ?? '';

  let v: Verdict;
  try {
    v = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as Verdict;
  } catch {
    console.error('\nМодель ответила не-JSON — вердикта нет. Ответ:');
    console.error(answer.slice(0, 400));
    process.exit(1);
  }

  const holds = evidenceHolds(v, content);
  console.log('\n── Вердикт ──');
  console.log(`Организация: ${v.org ?? 'не установлена'}`);
  console.log(`Уверенность модели: ${v.confident ? 'да' : 'нет'}`);
  console.log(`Публикует предупреждения об опасностях: ${v.publishes_hazard ? 'да' : 'нет'}`);
  console.log(`Улика: ${v.evidence ?? 'нет'}`);
  console.log(`Улика найдена в скачанном тексте: ${holds ? 'ДА' : 'НЕТ'}`);
  if (v.note) console.log(`Замечание модели: ${v.note}`);

  if (!holds) {
    // Вердикт без улики — это ответ по памяти, а мы спрашивали по тексту.
    console.log('\nВЕРДИКТ ОТБРОШЕН: улика не встречается в скачанном тексте дословно.');
    console.log('Это не «канал чужой» — это «модель не подтвердила присланным». Подпись остаётся прежней.');
    return;
  }
  if (!v.confident || !v.org) {
    console.log('\nСодержимое не позволяет назвать владельца. Подпись остаётся нейтральной — и это честный исход.');
    return;
  }
  console.log(`\nОПОЗНАН: ${v.org}. Улика дословно есть в канале — подпись источника можно уточнить.`);
}

if (require.main === module) {
  main().catch((e) => { console.error('Опознание упало:', (e as Error).message); process.exit(1); });
}
