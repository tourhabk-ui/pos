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
  mcpTourIds, mcpDiagnosis, urlTourKeys, resolveMcpTourKeys, sitemapUrlCount, findDivergences, formatDivergences, isSecondCanon,
  type ChannelTours, type TourLookup,
} from '@/lib/quality/channel-consistency';

const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf-8') : '');

const minSitemapUrls = Number(process.env.MIN_SITEMAP_URLS ?? 600);

const BASE = process.env.BASE ?? 'https://vedarai.ru';

/** Карточка по числу: код и куда перенаправило. Сеть не ответила — null. */
async function lookupTour(id: string): Promise<TourLookup> {
  // Число пришло из файла ответа MCP и уходит в адрес запроса: в адрес идёт
  // только то, что целиком состоит из цифр. mcpTourIds и так берёт `\d+`,
  // но проверка стоит у самого запроса — она не зависит от того, кто вызвал.
  if (!/^\d{1,15}$/.test(id)) return { status: 400, location: null };
  try {
    const res = await fetch(`${BASE}/catalog/tours/${encodeURIComponent(id)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const location = res.headers.get('location');
    return { status: res.status, location };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sitemap = read('sitemap.xml');
  // MCP называет тур числом, карта сайта и llms.txt — адресом (#2110): числа
  // переводятся в адреса у самого сайта, иначе каналы не с чем сравнить.
  const mcpIds = mcpTourIds(read('mcp.json'));
  const mcpKeys = await resolveMcpTourKeys(mcpIds, lookupTour);
  const channels: ChannelTours[] = [
    { channel: 'mcp', ids: mcpKeys.keys },
    { channel: 'llms', ids: urlTourKeys(read('llms.txt')) },
    { channel: 'sitemap', ids: urlTourKeys(sitemap) },
  ];

  const problems: string[] = [];

  console.log(
    'туры по каналам: ' +
    channels.map((c) => `${c.channel}=${[...c.ids].sort().join(',') || '—'}`).join(' | '),
  );

  // Пустой канал важнее расхождений и называется первым: один упавший канал
  // породил бы расхождения со всеми остальными и утопил настоящую причину.
  for (const c of channels) {
    if (c.ids.size !== 0) continue;
    // MCP назвал туры, но ни у одного не узнался адрес: канал не пуст, не
    // удалось проверить — это говорится ниже своим текстом.
    if (c.channel === 'mcp' && mcpIds.size > 0) continue;
    // У MCP спрашивается ПРИЧИНА. «Не отдал ни одного тура» — это симптом, под
    // которым помещаются пять разных бед, и восемь суток в #1155 он не назвал
    // ни одной. Остальные каналы — статические файлы, там причина видна по
    // размеру и содержимому.
    const why = c.channel === 'mcp' ? mcpDiagnosis(read('mcp.json')) : null;
    problems.push(
      why
        ? `канал ${c.channel} не отдал ни одного тура: ${why}`
        : `канал ${c.channel} не отдал ни одного тура`,
    );
  }

  // «Не смог проверить» — третий исход, и он не равен ни «хорошо», ни
  // «расхождение»: называется отдельно и краснит ночной прогон.
  if (mcpKeys.unresolved.length > 0) {
    problems.push(
      'не смог узнать адрес тура из MCP: ' +
      mcpKeys.unresolved.map((u) => `ID${u.id} (${u.why})`).join(', '),
    );
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
}

main().catch((e: unknown) => {
  // Падение самой сверки — тоже красное: тишина здесь читалась бы как «расхождений нет».
  console.error('сверка каналов не выполнилась:', e);
  process.exit(1);
});
