'use client';

/**
 * Живая обстановка — радар, лента предупреждений, сейсмический пульс.
 *
 * P0-3b (редизайн 31.07): реализации переехали с главной сюда, в
 * components/safety/ — главная показывает статус-пилюлю и плитку-ссылку на
 * /safety#radar, а тяжёлые виджеты рендерит страница «Спасателя». Данные —
 * серверный срез getSafetyLiveData() (app/_home/data.ts), один построитель
 * на всех потребителей.
 *
 * CSS компонентов экспортируется строкой LIVE_STATUS_CSS в скоупе .kh-live —
 * потребитель оборачивает блок в <div className="kh-live"> и вставляет стиль.
 * Цвета — только глобальные токены (+ локальный --radar для зелёной развёртки).
 */

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { SafetyAlert } from '@/app/_home/data';

export function fmtAgo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const min = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

// Абсолютная дата новости для ленты алертов: у МЧС/дорожных сводок важно ВИДЕТЬ
// само число (июльское закрытие ≠ свежее), а не только «N дн назад».
function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/**
 * Подпись строки ленты. Для ограничения (дорога перекрыта, пропускной режим)
 * возраст новости не значит ничего: туристу важно, действует ли оно СЕЙЧАС и до
 * какого числа. Подпись «18 дн назад» под работающим перекрытием читается как
 * «протухло» — ровно это и заметил владелец на живой главной.
 * Для остальных типов возраст осмыслен: сводка недельной давности и правда
 * стареет.
 */
const IN_FORCE_TYPES = new Set(['road_closure', 'flood', 'avalanche', 'landslide']);

export function alertStamp(a: { type: string | null; at: string | null; until: string | null }): string {
  if (a.type && IN_FORCE_TYPES.has(a.type)) {
    const until = fmtDate(a.until);
    return until ? `действует до ${until}` : 'действует';
  }
  return `${fmtDate(a.at)}${a.at ? ` · ${fmtAgo(a.at)}` : ''}`;
}

/**
 * Обрезка описания для ленты. Бегущая строка — поверхность одного взгляда, а
 * дорожные ограничения приходят абзацами на 400-600 символов: целиком они не
 * читаются ни в прокрутке, ни в раскрытом списке (владелец увидел два экрана
 * текста). Полный текст живёт на карточке маршрута, тут — суть.
 */
export function clip(text: string, max = 140): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—-]+$/, '')}…`;
}

function magColor(m: number): string {
  if (m >= 6) return 'var(--danger)';
  if (m >= 4.5) return 'var(--accent)';
  if (m >= 3) return 'var(--warning)';
  return 'var(--ocean)';
}
export const SRC_LABEL: Record<string, string> = { kbgsras: 'КБГС РАН', usgs: 'USGS', none: '' };

const LEVEL_COLOR: Record<string, string> = {
  critical: 'var(--danger)', danger: 'var(--accent)', warning: 'var(--warning)',
};
const KIND_LABEL: Record<string, string> = {
  volcano: 'Вулкан', thermal: 'Термы', quake: 'Сейсмика',
  bear: 'Медведь', report: 'Наблюдение',
};
const MAX_KM = 200; // внешнее кольцо

interface RadarHazard { lat: number; lng: number; level: string; kind: string; label: string; note: string }
interface Placed extends RadarHazard { x: number; y: number; dist: number }

/**
 * Радар обстановки: реальные точки (вулканы KVERT, сейсмика, модерированные
 * наблюдения туристов) по настоящему азимуту и расстоянию от центра. Центр —
 * геолокация (если разрешена) или Петропавловск. Луч-развёртка декоративен
 * поверх реальных блипов; несуществующих точек не рисуем.
 *
 * Радар НЕ обещает «безопасность»: медведей техника не отслеживает, а на
 * Камчатке медведь — главная реальная опасность и он может быть где угодно.
 * Отсюда постоянная приписка про медведей и пустое состояние, которое говорит
 * только о том, что радар реально видит, — не «опасностей нет».
 */
/**
 * Упрощённая береговая линия юго-восточной Камчатки — опорные точки (lat, lng).
 * Порядок: западный (охотский) берег с севера на юг, затем тихоокеанский с юга
 * на север; замыкание полигона идёт сушей за пределами скопа. Проецируется той
 * же формулой, что и точки радара, поэтому масштаб и сдвиг центра честные.
 * ДЕКОРАЦИЯ ориентирования, не навигация: линия огрублена до ~15 узлов.
 * Первый контур (01.08) рисовал весь полуостров внутри 200-км круга — блоб.
 */
const COASTLINE: Array<[number, number]> = [
  [54.3, 155.8], [53.5, 155.9], [53.0, 156.05], [52.5, 156.25], [51.8, 156.45], [51.2, 156.6],
  [51.0, 156.7], [51.5, 157.2], [52.0, 157.5], [52.35, 158.15], [52.55, 158.35], [52.75, 158.55],
  [52.87, 158.70], [52.92, 158.55], [53.03, 158.60], [53.02, 158.72], [52.98, 158.90],
  [53.10, 159.10], [53.15, 159.60], [53.10, 160.00], [53.09, 160.30], [53.25, 159.95],
  [53.80, 159.90], [54.10, 160.10], [54.50, 160.60],
];

export function RadarScope({ hazards, center }: { hazards: RadarHazard[]; center: { lat: number; lng: number; label: string } }) {
  const [c, setC] = useState(center);
  const [geo, setGeo] = useState<'idle' | 'ok' | 'deny'>('idle');
  const [sel, setSel] = useState<Placed | null>(null);
  const [copied, setCopied] = useState(false);

  const copyCoords = () => {
    const t = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    navigator.clipboard?.writeText(t)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setGeo('deny'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setC({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'Ваше местоположение' }); setGeo('ok'); setSel(null); },
      () => setGeo('deny'),
      { timeout: 8000, maximumAge: 300000 },
    );
  };

  const R = 92, CX = 100, CY = 100;
  const kmLat = 111.32, kmLng = 111.32 * Math.cos((c.lat * Math.PI) / 180);
  // В SVG последний нарисованный — сверху, поэтому критичные рисуем ПОСЛЕДНИМИ:
  // красный блип не должен прятаться под жёлтым
  const LEVEL_RANK: Record<string, number> = { warning: 0, danger: 1, critical: 2 };
  const placed: Placed[] = hazards
    .map((h) => {
      const north = (h.lat - c.lat) * kmLat;
      const east = (h.lng - c.lng) * kmLng;
      const dist = Math.hypot(north, east);
      return { ...h, dist, x: CX + (east / MAX_KM) * R, y: CY - (north / MAX_KM) * R };
    })
    .filter((h) => h.dist <= MAX_KM)
    .sort((a, b) => (LEVEL_RANK[a.level] ?? 0) - (LEVEL_RANK[b.level] ?? 0));

  // Берег — та же проекция, что у точек: сдвинулся центр — сдвинулся и берег.
  const coastPath = COASTLINE
    .map(([la, ln], i) => {
      const x = CX + (((ln - c.lng) * kmLng) / MAX_KM) * R;
      const y = CY - (((la - c.lat) * kmLat) / MAX_KM) * R;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ') + ' Z';

  const rings = [0.25, 0.5, 1]; // 50 / 100 / 200 км

  return (
    <div className="radar">
      <div className="scope">
        {/* role="img" — иначе подпись графики не попадает в accessibility tree
            предсказуемо. Подпись считается из того, что реально нарисовано:
            статичное «Радар обстановки» врало бы при пустом радаре. */}
        <svg
          viewBox="0 0 200 200"
          role="img"
          aria-label={`Радар обстановки: предупреждений в радиусе ${MAX_KM} км — ${placed.length}`}
        >
          <defs>
            <radialGradient id="sweepGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--radar)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--radar)" stopOpacity="0" />
            </radialGradient>
            <clipPath id="scopeClip"><circle cx={CX} cy={CY} r={R} /></clipPath>
          </defs>
          {/* Фон — суша по упрощённой береговой линии (COASTLINE выше),
              спроецированной формулами радара: масштаб колец и берег совпадают.
              Декорация ориентирования, aria-hidden. */}
          <g clipPath="url(#scopeClip)" aria-hidden>
            <path
              d={coastPath}
              fill="var(--radar)" fillOpacity="0.07"
              stroke="var(--radar)" strokeOpacity="0.25" strokeWidth="0.9"
              strokeLinejoin="round"
            />
          </g>
          {rings.map((k, i) => (
            <circle key={i} cx={CX} cy={CY} r={R * k} fill="none" stroke="var(--radar)" strokeOpacity={0.28} strokeWidth={0.8} />
          ))}
          <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="var(--radar)" strokeOpacity={0.18} strokeWidth={0.7} />
          <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="var(--radar)" strokeOpacity={0.18} strokeWidth={0.7} />
          <text x={CX} y={CY - R - 3} textAnchor="middle" className="rn">С</text>
          <g className="sweep">
            <path d={`M ${CX} ${CY} L ${CX} ${CY - R} A ${R} ${R} 0 0 1 ${CX + R * Math.sin(0.7)} ${CY - R * Math.cos(0.7)} Z`} fill="url(#sweepGrad)" />
            <line x1={CX} y1={CY} x2={CX} y2={CY - R} stroke="var(--radar)" strokeOpacity={0.7} strokeWidth={1} />
          </g>
          <circle cx={CX} cy={CY} r={2.4} fill="var(--radar)" />
          {placed.map((h, i) => (
            <g key={i} onClick={() => setSel(h)} style={{ cursor: 'pointer' }}>
              {h.level === 'critical' && <circle cx={h.x} cy={h.y} r={6} className="pulse" fill={LEVEL_COLOR[h.level]} />}
              <circle cx={h.x} cy={h.y} r={h.level === 'critical' ? 4 : h.level === 'danger' ? 3.2 : 2.6}
                fill={LEVEL_COLOR[h.level]} stroke="#fff" strokeWidth={0.6}
                style={sel === h ? { filter: 'drop-shadow(0 0 4px currentColor)' } : undefined} />
            </g>
          ))}
        </svg>
        {placed.length === 0 && <div className="clean">Сейсмики и тревог вулканов рядом нет</div>}
      </div>

      <div className="rmeta">
        <div className="rrow">
          <span className="rc">Центр: <b>{c.label}</b></span>
          {geo !== 'ok' && <button className="rgeo" onClick={useMyLocation}>Моё местоположение</button>}
        </div>
        {geo === 'ok' && (
          <button className="rcoord" onClick={copyCoords} title="Скопировать координаты">
            {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
            <span>{copied ? 'скопировано' : 'копировать'}</span>
          </button>
        )}
        {geo === 'deny' && <div className="rhint">Геолокация недоступна — показываю от Петропавловска.</div>}
        {sel ? (
          <button className="rsel" onClick={() => setSel(null)}>
            <span className="rdot" style={{ background: LEVEL_COLOR[sel.level] }} />
            <span className="rtx"><b>{sel.label}</b><span>{KIND_LABEL[sel.kind]} · {Math.round(sel.dist)} км · {sel.note}</span></span>
          </button>
        ) : (
          <div className="rleg">
            <span><i style={{ background: LEVEL_COLOR.critical }} />критично</span>
            <span><i style={{ background: LEVEL_COLOR.danger }} />опасно</span>
            <span><i style={{ background: LEVEL_COLOR.warning }} />внимание</span>
            <span className="rcount">{placed.length} рядом</span>
          </div>
        )}
        {/* Честность радара: медведей техника не видит, а это главная реальная
            опасность края. Приписка постоянная — пустой радар не значит «безопасно» */}
        <div className="rhint">
          Радар видит сейсмику, вулканы КВЕРТ и наблюдения туристов. Медведей он не видит —
          на Камчатке медведь может быть рядом всегда: шумите на тропе, держите дистанцию.{' '}
          <Link href="/safety/offline">Протокол встречи →</Link>
        </div>
      </div>
    </div>
  );
}

interface PulseQuake { magnitude: number; place: string; time: number; depth: number | null }

/**
 * Живая лента предупреждений — компактное окно ~4 строки с плавной вертикальной
 * прокруткой (экономит место на мобильном). Только актуальные алерты (фильтр и
 * срок годности — на стороне data.ts). При 1-2 записях не крутим — статичный
 * список; при большем числе — бесшовный цикл (список продублирован).
 *
 * Взаимодействие: тап РАСКРЫВАЕТ ленту в полный читаемый список и сворачивает
 * обратно. Раньше единственной реакцией была пауза анимации по :hover/:focus —
 * на телефоне тап давал «залипший» эмулированный hover, и лента просто
 * замирала на середине, не раскрываясь (фидбэк владельца). Теперь развёрнутое
 * состояние — статичный скроллящийся список без маски и без бегущей анимации.
 */
export function AlertsTicker({ alerts }: { alerts: SafetyAlert[] }) {
  const scroll = alerts.length > 2;
  const [open, setOpen] = useState(false);
  const animate = scroll && !open; // бегущая строка только в свёрнутом длинном списке
  const row = (a: SafetyAlert, i: number, dup: boolean) => (
    <li key={`${dup ? 'd' : 'a'}-${i}`} aria-hidden={dup || undefined}>
      <i className={a.severity >= 3 ? 'sev-hi' : a.severity === 2 ? 'sev-mid' : 'sev-lo'} />
      <span className="atx">
        {a.title}
        {a.description ? <span className="adesc">{clip(a.description)}</span> : null}
      </span>
      <span className="ago">{alertStamp(a)}</span>
    </li>
  );
  return (
    <div className={`ticker${scroll ? ' scroll' : ''}${open ? ' open' : ''}`}>
      <ul
        className="alerts ticker-track"
        style={animate ? { animationDuration: `${Math.max(16, alerts.length * 5)}s` } : undefined}
      >
        {alerts.map((a, i) => row(a, i, false))}
        {animate && alerts.map((a, i) => row(a, i, true))}
      </ul>
      {scroll && (
        <button
          type="button"
          className={`ticker-toggle${open ? ' open' : ''}`}
          aria-expanded={open}
          aria-label={open ? 'Свернуть ленту предупреждений' : 'Показать все предупреждения'}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className="tchev" size={16} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

/**
 * «Пульс полуострова» — реальные сейсмособытия (КБГС РАН / USGS) ритмом, а не
 * списком: сильнейший толчок крупно + столбики по магнитуде (свежие справа).
 * Тап по столбику → деталь. Столбики = настоящие события, не синтетика.
 */
export function SeismicPulse({ events, source }: { events: PulseQuake[]; source: string }) {
  const [sel, setSel] = useState<number | null>(null);
  if (events.length === 0) return null;
  const strongest = events.reduce((a, b) => (b.magnitude > a.magnitude ? b : a), events[0]);
  const bars = [...events].reverse(); // events: свежие первыми → разворот, чтобы свежие были справа
  const maxMag = Math.max(6, ...events.map((e) => e.magnitude));
  const selected = sel != null ? bars[sel] : null;
  return (
    <div className="pulse">
      <div className="phead">
        <div className="pbig">
          <b>M{strongest.magnitude.toFixed(1)}</b>
          <span>сильнейший · {strongest.depth != null ? `${Math.round(strongest.depth)} км · ` : ''}{fmtAgo(new Date(strongest.time).toISOString())}</span>
        </div>
        <div className="psrc">Пульс полуострова<i>{source}</i></div>
      </div>
      <div className="pbars">
        {bars.map((q, i) => (
          <button key={i} className={`pbar${sel === i ? ' on' : ''}`}
            style={{ height: `${Math.max(12, (q.magnitude / maxMag) * 100)}%`, background: magColor(q.magnitude) }}
            aria-label={`M${q.magnitude.toFixed(1)}`} onClick={() => setSel(sel === i ? null : i)} />
        ))}
      </div>
      <div className="paxis"><span>старее</span><span>сейчас →</span></div>
      {selected ? (
        <button className="psel" onClick={() => setSel(null)}>
          <span className="pmag" style={{ background: magColor(selected.magnitude) }}>{selected.magnitude.toFixed(1)}</span>
          <span className="ptx"><b>{selected.place}</b><span>{selected.depth != null ? `${Math.round(selected.depth)} км · ` : ''}{fmtAgo(new Date(selected.time).toISOString())}</span></span>
        </button>
      ) : (
        <div className="psum">за ~48 ч — {events.length} толчков · макс M{strongest.magnitude.toFixed(1)}</div>
      )}
    </div>
  );
}

export const LIVE_STATUS_CSS = `
.kh-live{--radar:#3FB950}
.kh-live .radar{border:1px solid var(--border);border-radius:16px;padding:16px;background:radial-gradient(120% 100% at 50% 0%,color-mix(in srgb,var(--radar) 8%,transparent),transparent 70%)}
.kh-live .radar .scope{position:relative;width:100%;max-width:300px;margin:0 auto}
.kh-live .radar .scope svg{width:100%;height:auto;display:block;overflow:visible}
.kh-live .radar .rn{font:600 8px var(--font-outfit),system-ui,sans-serif;fill:var(--radar);opacity:.8}
.kh-live .radar .sweep{transform-origin:100px 100px;animation:radarSweep 4.5s linear infinite}
@keyframes radarSweep{to{transform:rotate(360deg)}}
.kh-live .radar .pulse{animation:radarPulse 1.6s ease-out infinite;transform-origin:center;transform-box:fill-box}
@keyframes radarPulse{0%{opacity:.5;transform:scale(.6)}70%{opacity:0;transform:scale(1.8)}100%{opacity:0}}
.kh-live .radar .clean{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 11px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.06em;color:var(--text-secondary);background:var(--bg-primary);padding:6px 10px;border-radius:999px;border:1px solid var(--border)}
.kh-live .radar .rmeta{margin-top:14px}
.kh-live .radar .rrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.kh-live .radar .rc{font:400 10.5px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.kh-live .radar .rc b{color:var(--text-primary);font-weight:600}
.kh-live .radar .rgeo{font:600 9px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ocean);background:none;border:1px solid color-mix(in srgb,var(--ocean) 35%,transparent);border-radius:999px;padding:7px 11px;cursor:pointer;white-space:nowrap}
.kh-live .radar .rhint{margin-top:6px;font:400 9px/1.4 var(--fm);color:var(--text-muted)}
.kh-live .radar .rhint a{color:var(--ocean);text-decoration:none}
.kh-live .radar .rcoord{margin-top:6px;display:inline-flex;align-items:center;gap:8px;font:500 11px/1 var(--fm);color:var(--text-primary);background:none;border:none;padding:0;cursor:pointer;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.kh-live .radar .rcoord span{font:600 8px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--ocean)}
.kh-live .radar .rleg{margin-top:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.kh-live .radar .rleg span{display:inline-flex;align-items:center;gap:5px;font:400 9.5px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.kh-live .radar .rleg i{width:7px;height:7px;border-radius:50%}
.kh-live .radar .rleg .rcount{margin-left:auto;font:400 9px/1 var(--fm);color:var(--text-muted)}
.kh-live .radar .rsel{margin-top:12px;width:100%;display:flex;align-items:center;gap:11px;text-align:left;background:var(--bg-hover,color-mix(in srgb,var(--text-primary) 5%,transparent));border:1px solid var(--border);border-radius:12px;padding:11px 12px;cursor:pointer;font-family:var(--font-outfit),system-ui,sans-serif}
.kh-live .radar .rsel .rdot{width:9px;height:9px;border-radius:50%;flex:none}
.kh-live .radar .rsel .rtx{display:flex;flex-direction:column;gap:3px}
.kh-live .radar .rsel .rtx b{font:600 12.5px/1.2 var(--font-playfair),Georgia,serif;color:var(--text-primary)}
.kh-live .radar .rsel .rtx span{font:400 10px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.kh-live .safety{border:1px solid var(--border);padding:16px;margin-top:14px}
.kh-live .safety.calm{display:flex;flex-direction:column;gap:6px}
.kh-live .safety.calm b{font:600 15px/1.3 var(--font-playfair),Georgia,serif;color:var(--success)}
.kh-live .safety.calm span{font:400 11.5px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.kh-live .ticker{position:relative;overflow:hidden}
.kh-live .ticker.scroll{height:76px;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 84%,transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 84%,transparent 100%)}
.kh-live .ticker.scroll .ticker-track{animation:v7-ticker linear infinite;will-change:transform}
.kh-live .ticker.scroll.open{height:auto;max-height:min(58vh,420px);overflow-y:auto;-webkit-overflow-scrolling:touch;-webkit-mask-image:none;mask-image:none}
.kh-live .ticker.scroll.open .ticker-track{animation:none;transform:none}
/* Раскрывашка — отдельная цель 44px в углу, а НЕ вся площадь ленты.
   Пока кнопка занимала inset:0, любой тап по ленте (в том числе случайный при
   прокрутке страницы пальцем) разворачивал её на пол-экрана — владелец поймал
   это на живой главной. Кнопка должна быть там, где нарисован шеврон. */
.kh-live .ticker-toggle{position:absolute;border:0;cursor:pointer;color:var(--text-muted);display:flex;align-items:center;justify-content:center;z-index:2;
  width:44px;height:44px;border-radius:999px;background:transparent}
.kh-live .ticker-toggle:not(.open){right:0;bottom:0}
.kh-live .ticker-toggle.open{top:2px;right:2px;width:32px;height:32px;background:var(--card);border:1px solid var(--border)}
.kh-live .ticker-toggle .tchev{transition:transform .2s ease;opacity:.7}
.kh-live .ticker-toggle.open .tchev{transform:rotate(180deg);opacity:1}
@keyframes v7-ticker{from{transform:translateY(0)}to{transform:translateY(-50%)}}
.kh-live .alerts{list-style:none}
.kh-live .alerts li{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.kh-live .ticker:not(.scroll) .alerts li:first-child{border-top:0}
.kh-live .alerts li i{width:6px;height:6px;border-radius:50%;flex:none;align-self:center}
.kh-live .alerts i.sev-hi{background:var(--danger)}.kh-live .alerts i.sev-mid{background:var(--warning)}.kh-live .alerts i.sev-lo{background:var(--ocean)}
.kh-live .alerts .atx{font:500 12px/1.4 var(--font-outfit),system-ui,sans-serif;flex:1}
.kh-live .alerts .adesc{display:block;margin-top:2px;font:400 10.5px/1.35 var(--font-outfit),system-ui,sans-serif;color:var(--text-muted)}
.kh-live .alerts .ago{font:400 8.5px/1 var(--fm);color:var(--text-muted);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.kh-live .ticker.scroll{height:auto;-webkit-mask-image:none;mask-image:none}.kh-live .ticker.scroll .ticker-track{animation:none}}
.kh-live .safety .src{margin-top:12px;padding-top:10px;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);font:400 8.5px/1.4 var(--fm);color:var(--text-muted)}
.kh-live .pulse{margin-top:12px;border:1px solid var(--border);border-radius:14px;padding:13px 14px;background:color-mix(in srgb,var(--bg-hover) 45%,transparent)}
.kh-live .pulse .phead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.kh-live .pulse .pbig b{font:600 21px/1 var(--font-playfair),Georgia,serif;letter-spacing:-.02em;display:block}
.kh-live .pulse .pbig span{display:block;margin-top:4px;font:400 8.5px/1.3 var(--fm);color:var(--text-secondary)}
.kh-live .pulse .psrc{text-align:right;font:600 8px/1.3 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted)}
.kh-live .pulse .psrc i{display:block;font:400 7.5px/1.4 var(--fm);letter-spacing:.06em;color:var(--text-muted);text-transform:none;font-style:normal;margin-top:2px;opacity:.85}
.kh-live .pulse .pbars{margin-top:12px;display:flex;align-items:flex-end;gap:3px;height:44px}
.kh-live .pulse .pbar{flex:1;min-width:0;border:0;padding:0;border-radius:2px;cursor:pointer;opacity:.62;transition:opacity .18s ease,box-shadow .18s ease;transform-origin:bottom}
.kh-live .pulse .pbar:hover{opacity:.9}
.kh-live .pulse .pbar.on{opacity:1;box-shadow:0 0 0 1.5px var(--bg-primary),0 0 0 3px var(--text-primary)}
.kh-live .pulse .paxis{margin-top:8px;display:flex;justify-content:space-between;font:400 7.5px/1 var(--fm);letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted)}
.kh-live .pulse .psum{margin-top:11px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);font:400 9px/1.4 var(--fm);color:var(--text-secondary)}
.kh-live .pulse .psel{margin-top:11px;width:100%;display:flex;align-items:center;gap:10px;text-align:left;background:none;border:0;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);padding:10px 0 0;cursor:pointer;font-family:var(--font-outfit),system-ui,sans-serif}
.kh-live .pulse .psel .pmag{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font:700 11px/1 var(--font-playfair),Georgia,serif}
.kh-live .pulse .psel .ptx{display:flex;flex-direction:column;gap:2px}
.kh-live .pulse .psel .ptx b{font:500 11px/1.3 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.kh-live .pulse .psel .ptx span{font:400 8px/1.3 var(--fm);color:var(--text-muted)}
`;
