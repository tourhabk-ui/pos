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
 * ── Почему без модели ──────────────────────────────────────────────────────
 *
 * Первая редакция звала сюда Astra. Прогон 1 показал, что звать некого:
 * вопрос «чей это канал» решил ЗАГОЛОВОК СТРАНИЦЫ — «Александр Колесов.
 * О погоде в Петербурге» — и описание со ссылкой на meteo.nw.ru. Модель в это
 * время отвечала HTTP 402 и не сказала ничего.
 *
 * Вывод владельца по итогам дня: «я понял что астра бесполезна». Уточнение,
 * которое важно для кода: бесполезна КАК ИСТОЧНИК УТВЕРЖДЕНИЙ. Из двенадцати
 * её предложений в подборе источников четыре канала не существовали, один был
 * мёртв с 2022 года, один дублировал уже собираемое, а kammeteo — «приоритетный
 * кандидат на лавинные бюллетени Камчатки» — оказался питерским блогером.
 * Полезными стали четыре, и каждое стало полезным не от её слов, а от того,
 * что перепись потом сходила по адресу.
 *
 * Здесь проверять нечем: «этот канал принадлежит такой-то службе» машиной не
 * подтверждается. Место, где модель нельзя проверить, — не её место. Поэтому
 * скрипт просто ПОКАЗЫВАЕТ скачанное: заголовок, описание, даты, тексты
 * постов. Читает человек, и в случае kammeteo ему хватило одной строки.
 *
 * Ничего не пишет и никуда не ходит, кроме самого канала. Ключей не просит.
 *
 * Использование: npx tsx scripts/channel-identity-runner.ts <канал>
 */
import { lastTelegramPost } from './source-discovery-runner';
import { htmlToText } from '../lib/html/text';
import { decodeHtmlEntities } from '../lib/html/entities';

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

async function main(): Promise<void> {
  const channel = (process.argv[2] || '').trim();
  if (!channel) {
    console.error('Не назван канал. Использование: npx tsx scripts/channel-identity-runner.ts <канал>');
    process.exit(1);
  }

  // Ключей не спрашиваем: ходим только в сам канал. Прогон, которому нечего
  // просить, не может упасть на чужом балансе — прогон 1 упал именно так.
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

  console.log('\nВсе прочитанные посты:');
  for (const p of content.posts) console.log(`  · ${p.slice(0, 400)}`);

  // Вердикта здесь нет намеренно. «Канал принадлежит такой-то службе» —
  // утверждение, которое машина подтвердить не может, а модель на нём уже
  // ошиблась: kammeteo был назван камчатским, оказавшись питерским. Читает
  // человек, и решение принимает он.
  console.log('\nВердикта нет: чей это канал, решает человек по тексту выше.');
}

