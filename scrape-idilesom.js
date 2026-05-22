/**
 * scrape-idilesom.js
 *
 * Парсит ВСЕ записи idilesom.com/kam/places через BrightData Web Unlocker.
 * Разделяет на два типа:
 *   place  — географический факт (вулкан, озеро, источник, бухта…)
 *   route  — путь/маршрут (поход, трек, тропа, восхождение…)
 *
 * Запуск:
 *   node scrape-idilesom.js              # полный прогон
 *   node scrape-idilesom.js --limit 50   # первые 50 для теста
 *
 * Результат: idilesom-places.json  { places: [...], routes: [...] }
 */

const fs = require("fs");

const API_TOKEN = process.env.BRIGHTDATA_API_TOKEN || "eaf70e24-b62f-4a8d-a0b2-9eb760f3f7ec";
const DELAY_MS  = 700;
const limitArg  = process.argv.indexOf("--limit");
const LIMIT     = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 9999;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── BrightData ───────────────────────────────────────────────────────────────

async function fetchVia(url) {
  const resp = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ zone: "unlocker", url, format: "raw" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// ─── Collect all IDs from paginated listing ───────────────────────────────────

async function fetchAllIds() {
  const seen = new Set();

  process.stdout.write("Fetching page 1... ");
  const html = await fetchVia("https://idilesom.com/kam/places");
  (html.match(/\/kam\/places\/(\d+)/g) || []).forEach(m => seen.add(m.split("/").pop()));
  console.log(`${seen.size} IDs`);

  for (let page = 2; page <= 99; page++) {
    await sleep(400);
    process.stdout.write(`  page ${page}... `);
    const res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        zone: "unlocker",
        url: `https://idilesom.com/kam/places?page=${page}`,
        format: "raw",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (data.empty) { console.log("empty — done."); break; }
    const before = seen.size;
    (data.list?.match(/\/kam\/places\/(\d+)/g) || []).forEach(m => seen.add(m.split("/").pop()));
    console.log(`+${seen.size - before} (total: ${seen.size})`);
  }
  return [...seen];
}

// ─── Classification ───────────────────────────────────────────────────────────

function classify(title, desc) {
  const t = (title + " " + (desc || "")).toLowerCase();
  if (/\bмаршрут\b|\bпоход\b|\bтрек\b|\bтропа\b|\bвосхожден|\bпереход\b|\bтраверс\b|\bрадиальн|\bпуть к\b/.test(t))
    return "route";
  if (/вулкан|сопка|кратер|кальдер|озеро|лагуна|источник|термаль|гейзер|нарзан|водопад|бухта|мыс|пляж|\bрека\b|ручей|пещер|остров|перевал|хребет|ледник/.test(t))
    return "place";
  return "place";
}

function locationType(title, desc) {
  const t = (title + " " + (desc || "")).toLowerCase();
  if (/вулкан|сопка|кратер|кальдер/.test(t)) return "volcano";
  if (/гейзер/.test(t))                       return "geyser";
  if (/источник|термаль|нарзан/.test(t))      return "hot_spring";
  if (/озеро|лагуна/.test(t))                 return "lake";
  if (/водопад/.test(t))                      return "waterfall";
  if (/пляж/.test(t))                         return "beach";
  if (/бухта/.test(t))                        return "bay";
  if (/мыс/.test(t))                          return "cape";
  if (/\bрека\b|ручей/.test(t))               return "river";
  if (/пещер/.test(t))                        return "cave";
  if (/перевал/.test(t))                      return "mountain_pass";
  if (/хребет|горн|гора|массив|ледник/.test(t)) return "mountain";
  if (/остров/.test(t))                       return "island";
  return "other";
}

// ─── Parse detail page ────────────────────────────────────────────────────────

function parseDetail(html, id) {
  const get = (re) => { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null; };

  const title =
    (html.match(/property="og:title"\s+content="([^"]+)"/) || [])[1]?.split(/\s*[-—]\s*(ИдиЛесом|Камчатск)/i)[0]?.trim() ||
    get(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!title) return null;

  const ogDesc = (html.match(/property="og:description"\s+content="([^"]+)"/) || [])[1] || "";
  const descBlocks = [...html.matchAll(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(t => t.length > 30);
  const description = descBlocks[0] || ogDesc || null;

  // Координаты из schema.org
  const latM = html.match(/"latitude"\s*:\s*([\d.]+)/);
  const lngM = html.match(/"longitude"\s*:\s*([\d.]+)/);
  let lat = latM ? parseFloat(latM[1]) : null;
  let lng = lngM ? parseFloat(lngM[1]) : null;

  // GPS-трек
  let coordinates = [];
  const coordBlocks = html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) || [];
  for (const block of coordBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (!Array.isArray(parsed) || parsed.length < 3 || !Array.isArray(parsed[0])) continue;
      const isGeoJSON = Math.abs(parsed[0][0]) > 90;
      const coords = isGeoJSON
        ? parsed.map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
        : parsed.map(p => [p[1], p[0]]);
      if (coords.length > coordinates.length) coordinates = coords;
    } catch {}
  }

  // Фallback lat/lng из трека
  if ((!lat || !lng) && coordinates.length > 0) {
    const mid = coordinates[Math.floor(coordinates.length / 2)];
    lng = mid[0]; lat = mid[1];
  }
  if (!lat || !lng) return null;

  // Дистанция
  const distM = html.match(/(\d+[.,]\d+)\s*км/);
  const distance_km = distM ? parseFloat(distM[1].replace(",", ".")) : null;

  // Длительность
  const duration = get(/(Целый день|Несколько часов|Несколько дней|Больше недели)/i);

  // Фото
  const images = [];
  const imgRe = /src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    if (!/icon|logo|avatar|sprite|thumb/i.test(im[1])) images.push(im[1]);
    if (images.length >= 6) break;
  }

  const geometry = coordinates.length >= 3
    ? { type: "LineString", coordinates, source: "idilesom" }
    : null;

  return { id, title, description, lat, lng, coordinates: coordinates.length, geometry, distance_km, duration, images, sourceUrl: `https://idilesom.com/kam/places/${id}` };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== idilesom.com/kam/places — полный парсинг ===\n");

  const allIds = await fetchAllIds();
  const ids = allIds.slice(0, LIMIT);
  console.log(`\nВсего ID: ${allIds.length}${LIMIT < 9999 ? ` → обрабатываем ${ids.length}` : ""}\n`);

  const places = [];
  const routes = [];
  let noData = 0, errors = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    process.stdout.write(`[${i + 1}/${ids.length}] id=${id} `);

    try {
      await sleep(DELAY_MS);
      const html = await fetchVia(`https://idilesom.com/kam/places/${id}`);
      const entry = parseDetail(html, id);

      if (!entry) {
        process.stdout.write("нет данных/координат\n");
        noData++;
        continue;
      }

      const kind = classify(entry.title, entry.description);
      if (kind === "place") {
        places.push({ ...entry, location_type: locationType(entry.title, entry.description) });
        process.stdout.write(`PLACE [${locationType(entry.title, entry.description)}] "${entry.title.slice(0, 45)}"\n`);
      } else {
        routes.push(entry);
        process.stdout.write(`ROUTE "${entry.title.slice(0, 45)}"${entry.coordinates > 0 ? ` +${entry.coordinates}pts` : ""}\n`);
      }
    } catch (e) {
      process.stdout.write(`ОШИБКА: ${e.message.slice(0, 60)}\n`);
      errors++;
    }
  }

  const result = { scraped_at: new Date().toISOString(), total: places.length + routes.length, places, routes };
  fs.writeFileSync("idilesom-places.json", JSON.stringify(result, null, 2));

  console.log(`\n=== ГОТОВО ===`);
  console.log(`places:  ${places.length}`);
  console.log(`routes:  ${routes.length}`);
  console.log(`нет данных: ${noData}`);
  console.log(`ошибки:  ${errors}`);
  console.log(`Файл:    idilesom-places.json`);
}

main().catch(console.error);
