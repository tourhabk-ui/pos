/**
 * scripts/check-channel-consistency.ts
 *
 * Сверка каналов видимости: одно ли платформа говорит людям, поисковикам и
 * ИИ-агентам. Запускается ночным прогоном по снятым файлам.
 *
 * Логика сравнения живёт в lib/quality/channel-consistency.ts и покрыта
 * тестами — здесь только чтение файлов, пороги и вывод. Дублировать разбор в
 * скрипте нельзя: разошедшиеся копии одной проверки — это ровно та болезнь,
 * которую проверка и лечит.
 *
 * Код возврата 1 при расхождении: ночной прогон обязан краснеть, иначе
 * находка останется строкой в логе, которую никто не читает.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  mcpTourIds, urlTourIds, sitemapUrlCount, findDivergences, formatDivergences, isSecondCanon,
  type ChannelTours,
} from '@/lib/quality/channel-consistency';

const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf-8') : '');

const minSitemapUrls = Number(process.env.MIN_SITEMAP_URLS ?? 600);

const sitemap = read('sitemap.xml');
const channels: ChannelTours[] = [
  { channel: 'mcp', ids: mcpTourIds(read('mcp.json')) },
  { channel: 'llms', ids: urlTourIds(read('llms.txt')) },
  { channel: 'sitemap', ids: urlTourIds(sitemap) },
];

const problems: string[] = [];

console.log(
  'туры по каналам: ' +
  channels.map((c) => `${c.channel}=${[...c.ids].sort().join(',') || '—'}`).join(' | '),
);

// Пустой канал важнее расхождений и называется первым: один упавший канал
// породил бы расхождения со всеми остальными и утопил настоящую причину.
for (const c of channels) {
  if (c.ids.size === 0) problems.push(`канал ${c.channel} не отдал ни одного тура`);
}

const diverged = findDivergences(channels);
if (diverged.length > 0) problems.push(formatDivergences(diverged));

const urls = sitemapUrlCount(sitemap);
console.log(`адресов в карте сайта: ${urls} (порог ${minSitemapUrls})`);
if (urls < minSitemapUrls) {
  problems.push(`карта сайта похудела: ${urls} адресов при пороге ${minSitemapUrls}`);
}

const altCode = Number(read('alt.code').trim() || 0);
const altBytes = existsSync('alt.body') ? readFileSync('alt.body').length : 0;
console.log(`второй домен: HTTP ${altCode}, ${altBytes} байт`);
if (isSecondCanon(altCode, altBytes)) {
  problems.push(
    `второй домен отдаёт содержимое (HTTP ${altCode}, ${altBytes} байт) вместо перенаправления на канонический`,
  );
}

writeFileSync('problems.txt', problems.join('\n'));

if (problems.length > 0) {
  console.log('\n── расхождения ──');
  for (const p of problems) console.log(' · ' + p);
  process.exit(1);
}
console.log('\nКаналы говорят одно и то же.');
