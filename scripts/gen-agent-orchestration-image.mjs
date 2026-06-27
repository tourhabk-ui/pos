/**
 * Генератор картинки для поста @ai_hub_money: схема агентной оркестрации.
 * SVG → PNG через sharp. Брендовые токены (тёмная тема).
 * Запуск: node scripts/gen-agent-orchestration-image.mjs
 * Выход:  public/images/social/agent-orchestration.png  (1280x720)
 */
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'images', 'social', 'agent-orchestration.png');

// ── Brand tokens (dark) ──
const C = {
  bg:     '#0D1117',
  bg2:    '#161B22',
  card:   '#21262D',
  accent: '#E8734A',   // orange (dark variant)
  ocean:  '#00A8CC',   // cyan
  success:'#3FB950',
  text:   '#F0F6FC',
  muted:  '#8B949E',
  border: 'rgba(255,255,255,0.10)',
};

const W = 1280, H = 720;

// helper: cluster card
function card(x, y, w, h, accent, title, lines) {
  const items = lines.map((l, i) =>
    `<text x="${x + 20}" y="${y + 64 + i * 26}" font-family="Inter, Arial, sans-serif" font-size="17" fill="${C.muted}">${l}</text>`
  ).join('');
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.card}" stroke="${C.border}" stroke-width="1"/>
    <rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
    <text x="${x + 20}" y="${y + 34}" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700" fill="${C.text}">${title}</text>
    ${items}`;
}

function arrow(x1, y1, x2, y2, color) {
  return `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="${color}" stroke-width="2" stroke-dasharray="5 5" opacity="0.55" marker-end="url(#arr)"/>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg}"/>
      <stop offset="1" stop-color="${C.bg2}"/>
    </linearGradient>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="${C.muted}"/>
    </marker>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Title -->
  <text x="64" y="78" font-family="Georgia, 'Times New Roman', serif" font-size="40" font-weight="700" fill="${C.text}">Команда AI-агентов</text>
  <text x="64" y="116" font-family="Inter, Arial, sans-serif" font-size="22" fill="${C.muted}">спорят · учатся друг у друга · оркеструются — в одном проде</text>

  <!-- Arrows to/from central brain -->
  ${arrow(360, 250, 560, 350, C.accent)}
  ${arrow(920, 250, 720, 350, C.ocean)}
  ${arrow(360, 520, 560, 430, C.success)}
  ${arrow(920, 520, 720, 430, C.accent)}

  <!-- Central brain -->
  <rect x="540" y="330" width="200" height="120" rx="16" fill="${C.card}" stroke="${C.ocean}" stroke-width="2"/>
  <text x="640" y="378" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="700" fill="${C.text}">ОБЩИЙ МОЗГ</text>
  <text x="640" y="406" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="15" fill="${C.muted}">память · знания</text>
  <text x="640" y="426" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="15" fill="${C.muted}">утренний брифинг</text>

  <!-- 4 clusters -->
  ${card(64, 150, 296, 150, C.accent, 'Состязательность', ['Bull — сигналы покупки', 'Bear — риски и возражения', 'Arbiter — взвешивает обоих'])}
  ${card(920, 150, 296, 150, C.ocean, 'Агент → агенту', ['Scout находит пробел', '→ заводит GitHub-issue', '→ кодер реализует'])}
  ${card(64, 420, 296, 150, C.success, 'Само-эволюция', ['growth — находит баг', 'evolution — генерит фикс', 'feedback — учит правилу'])}
  ${card(920, 420, 296, 150, C.accent, 'Оркестрация', ['пайплайны и fan-out', 'guardrails: tsc + тесты', 'human-in-the-loop'])}

  <!-- Footer -->
  <text x="64" y="690" font-family="Inter, Arial, sans-serif" font-size="16" fill="${C.muted}">Ведар · Volcano OS — туристическая платформа Камчатки на агентах</text>
  <text x="1216" y="690" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="700" fill="${C.ocean}">@ai_hub_money</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log('written:', OUT);
