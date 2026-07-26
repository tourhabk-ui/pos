/**
 * Обложки для новостных постов каналов — вариативность вместо одной и той же
 * картинки. До этого промпты были фиксированными шаблонами («neural network,
 * glowing blue and purple, digital brain…» / «volcanic mountains, bears…»),
 * и Pollinations штамповал визуально одинаковые обложки: seed менял детали,
 * но композицию и палитру диктовал неизменный текст.
 *
 * Решение детерминированное, без лишнего LLM-вызова: сюжет, стиль и палитра
 * выбираются хэшем от текста новости. Разные новости — разные комбинации
 * (12x6x6 = 432 варианта у AI-канала), одна и та же новость стабильно даёт
 * одну обложку (перепост не «переодевается»). Тема новости входит в промпт.
 */

/** FNV-1a — быстрый детерминированный хэш строки. */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(pool: readonly T[], hash: number, slot: number): T {
  // Разные слоты берут разные биты хэша, чтобы выбор был независимым
  return pool[Math.floor(hash / Math.pow(pool.length, slot)) % pool.length];
}

// ── AI-канал ──────────────────────────────────────────────────────────────

const AI_SUBJECTS = [
  'macro shot of a silicon chip wafer with intricate circuits',
  'server room aisle with rows of glowing racks',
  'robotic arm assembling a circuit board',
  'holographic interface floating above a workdesk',
  'satellite orbiting Earth at night with city lights below',
  'lines of code reflected in eyeglasses in a dark room',
  'bundle of fiber optic strands emitting light',
  'isometric cutaway of a data center building',
  'printed circuit board landscape shot from above like a city',
  'humanoid robot silhouette in a doorway of light',
  'mechanical keyboard mid-keystroke with floating symbols',
  'network graph of glowing nodes and edges in space',
] as const;

const AI_STYLES = [
  'photorealistic, shallow depth of field',
  'isometric 3D illustration',
  'minimal flat illustration with bold shapes',
  'blueprint schematic style with fine linework',
  'cinematic wide shot with volumetric light',
  'long exposure with light trails',
] as const;

const AI_PALETTES = [
  'teal and amber color palette',
  'monochrome with a single orange accent',
  'deep green and gold tones',
  'ice blue and white tones',
  'warm sunset gradient tones',
  'crimson and slate grey palette',
] as const;

export function aiNewsImagePrompt(summary: string): string {
  const h = hashStr(summary);
  return [
    pick(AI_SUBJECTS, h, 0),
    `theme: ${summary.slice(0, 80)}`,
    pick(AI_STYLES, h, 1),
    pick(AI_PALETTES, h, 2),
    'high detail, no text, no watermarks',
  ].join(', ');
}

// ── Туристический канал ───────────────────────────────────────────────────

const TRAVEL_SUBJECTS = [
  'volcanic peak rising above a sea of clouds in Kamchatka',
  'brown bear standing by a wild salmon river',
  'steep ocean cliffs with seabird colonies and crashing waves',
  'geyser steam rising at dawn in a green valley',
  'alpine tundra covered in wildflowers below a glacier',
  'helicopter flying over a turquoise crater lake',
  'winding hiking trail through stone birch forest',
  'small fishing boat in a calm misty bay',
  'natural hot spring pools with steam in snowy landscape',
  'black volcanic sand beach with dramatic waves',
] as const;

const TRAVEL_LIGHT = [
  'golden hour light',
  'dramatic stormy sky',
  'soft morning fog',
  'crisp winter light',
  'late summer evening glow',
] as const;

export function travelNewsImagePrompt(summary: string): string {
  const h = hashStr(summary);
  return [
    pick(TRAVEL_SUBJECTS, h, 0),
    `theme: ${summary.slice(0, 80)}`,
    pick(TRAVEL_LIGHT, h, 1),
    'national geographic style photography, cinematic, 8K, no people, no text, no watermarks',
  ].join(', ');
}
