/**
 * GET /api/widget/lead.js?partner=SLUG
 * Returns embeddable JavaScript for partner lead-form widget.
 *
 * Usage on partner site:
 *   <script src="https://vedarai.ru/api/widget/lead.js?partner=gorybkoleno" defer></script>
 *
 * The script injects a floating "Заявка на тур" button and a modal with
 * an iframe pointing to /widget/lead-form/SLUG (same-origin form, no CORS needed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { widgetStyle } from '@/lib/embed/widget-style';
import { hostFromReferer } from '@/lib/embed/widget-origin';
import { WIDGET_PATH_SCRUB_JS, WIDGET_PATH_SCRUB_MAX } from '@/lib/embed/widget-path-scrub';
import { recordWidgetServed } from '@/lib/embed/widget-telemetry';

export const dynamic = 'force-dynamic';

interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  widget_config: Record<string, unknown> | null;
  widget_domains: string[];
}


function jsStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function corsHeaders(origin: string | null, domains: string[]): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/javascript; charset=utf-8',
    // Правда о кэше: общее правило next.config.js отдаёт этот путь с
    // no-store и перебивает заголовок роута, так что прежние «5 минут» до
    // браузера не доходили (§10.09, ревью PR #2518). Каждый просмотр — выдача,
    // на этом стоит счёт served в widget_daily.
    'Cache-Control': 'no-store',
  };
  if (!origin) return h;
  try {
    const host = new URL(origin).hostname;
    const ok = domains.some(d => {
      const clean = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return host === clean || host.endsWith(`.${clean}`);
    });
    if (ok) h['Access-Control-Allow-Origin'] = origin;
  } catch { /* skip */ }
  return h;
}

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get('partner') ?? '';

  if (!slug || slug.length > 100 || !/^[\w-]+$/.test(slug)) {
    return new NextResponse('/* invalid partner slug */', {
      status: 400,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }

  const { rows } = await pool.query<PartnerRow>(
    `SELECT id::text AS id, name, slug, widget_config, widget_domains
     FROM partners
     WHERE slug = $1 AND widget_enabled = true
     LIMIT 1`,
    [slug]
  );

  const p = rows[0];
  if (!p) {
    return new NextResponse('/* partner not found or widget disabled */', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }

  const { accent, buttonText, position, bottom } = widgetStyle(p.widget_config ?? {});

  const BASE = 'https://vedarai.ru';

  const js = `
(function () {
  if (window.__th_widget_${jsStr(slug)}) return;
  window.__th_widget_${jsStr(slug)} = true;

  var SLUG = '${jsStr(slug)}';
  var BASE = '${jsStr(BASE)}';
  var ACCENT = '${jsStr(accent)}';
  var BTN_TEXT = '${jsStr(buttonText)}';
  var POS = '${jsStr(position)}';
  var BOTTOM = ${bottom};

  /* ── Floating button ── */
  var btn = document.createElement('button');
  btn.id = '__th_btn_' + SLUG;
  btn.textContent = BTN_TEXT;
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: BOTTOM + 'px',
    [POS === 'left' ? 'left' : 'right']: '24px',
    zIndex: '2147483646',
    background: ACCENT,
    color: '#fff',
    border: 'none',
    borderRadius: '28px',
    padding: '12px 20px',
    fontSize: '14px',
    fontFamily: "'Outfit', system-ui, sans-serif",
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    transition: 'transform 0.15s, box-shadow 0.15s',
    lineHeight: '1.3',
  });
  btn.addEventListener('mouseenter', function () {
    btn.style.transform = 'translateY(-2px)';
    btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.24)';
  });
  btn.addEventListener('mouseleave', function () {
    btn.style.transform = '';
    btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.18)';
  });

  /* ── Modal overlay ── */
  var overlay = document.createElement('div');
  overlay.id = '__th_overlay_' + SLUG;
  Object.assign(overlay.style, {
    display: 'none',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  });

  /* ── Iframe wrapper ── */
  var wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'relative',
    width: '100%',
    maxWidth: '420px',
    background: '#fff',
    borderRadius: '16px',
    overflow: 'hidden',
    boxShadow: '0 24px 64px rgba(0,0,0,0.32)',
  });

  /* ── Close button ── */
  var closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  Object.assign(closeBtn.style, {
    position: 'absolute',
    top: '10px',
    right: '14px',
    zIndex: '1',
    background: 'transparent',
    border: 'none',
    fontSize: '22px',
    lineHeight: '1',
    cursor: 'pointer',
    color: '#6B6560',
  });

  /* ── Iframe ──
     Высоту сообщает сама форма (postMessage th:height). До 29.09 окно было
     440 px со scrolling="no" при форме в 537 px, и «Отправить заявку»
     оказывалась за краем. Пока сообщения нет — стартовая высота с запасом,
     и прокрутка разрешена: форма обязана быть досягаема при любой высоте. */
  /* Откуда пришёл человек (аудит 15.10, WID-measure): хост и путь страницы
     партнёра — без query и hash, там бывают телефон и ключи. Сервер сверит
     хост со списком доменов партнёра; хост подделывается — это сигнал для
     счёта, а не замок.
     Путь чистится от телефонов и почты ЗДЕСЬ, до адреса окна (аудит 15.10,
     R-path): сырой путь оседал в access-логах vedarai.ru и в Referer запросов
     окна. Правило — scrubWidgetPath (lib/embed/widget-path-scrub.ts), сюда
     вставлено его ES5-копией; обрезка — после чистки. Путь длиннее
     WIDGET_PATH_SCRUB_MAX не разбирается и не отправляется (ревью R-path):
     портянка из ссылки на страницу партнёра не должна вешать вкладку. */
  ${WIDGET_PATH_SCRUB_JS}
  var FROM_HOST = String(location.hostname || '');
  var RAW_PATH = String(location.pathname || '');
  var FROM_PATH = RAW_PATH.length > ${WIDGET_PATH_SCRUB_MAX} ? '' : scrubPath(RAW_PATH).slice(0, 200);
  var iframe = document.createElement('iframe');
  iframe.src = BASE + '/widget/lead-form/' + encodeURIComponent(SLUG)
    + '?host=' + encodeURIComponent(FROM_HOST) + '&path=' + encodeURIComponent(FROM_PATH);
  Object.assign(iframe.style, {
    display: 'block',
    width: '100%',
    height: 'min(600px, calc(100vh - 64px))',
    border: 'none',
  });
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('title', 'Форма заявки на тур');

  wrap.appendChild(closeBtn);
  wrap.appendChild(iframe);
  overlay.appendChild(wrap);

  /* ── Open / close logic ── */
  /* Маяк открытия: один на просмотр страницы, только партнёр, род и хост —
     без пути и без ПД. Шлёт страница партнёра, а не iframe: в окне формы нет
     ни Метрики, ни service worker. Нет sendBeacon — счёта нет, форма работает. */
  var beaconSent = false;
  function beacon() {
    if (beaconSent) return;
    beaconSent = true;
    if (typeof navigator.sendBeacon !== 'function') return;
    navigator.sendBeacon(BASE + '/api/widget/event',
      JSON.stringify({ partner: SLUG, kind: 'open', widget: 'form', host: FROM_HOST }));
  }
  function open() { overlay.style.display = 'flex'; beacon(); }
  function close() { overlay.style.display = 'none'; }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  /* ── PostMessage from iframe ── */
  /* Высота окна = высота формы, но не выше экрана. Экран меняется (поворот,
     клавиатура на телефоне) — пересчитываем от последней высоты формы,
     иначе «Отправить заявку» уходит за край. */
  var formHeight = 0;
  function fitFrame() {
    if (!formHeight) return;
    iframe.style.height = Math.max(200, Math.min(formHeight, window.innerHeight - 64)) + 'px';
  }
  window.addEventListener('resize', fitFrame);
  window.addEventListener('message', function (e) {
    if (e.origin !== BASE) return;
    if (e.data === 'th:close') { close(); return; }
    if (e.data && e.data.type === 'th:height' && typeof e.data.height === 'number' && e.source === iframe.contentWindow) {
      formHeight = e.data.height;
      fitFrame();
    }
  });

  /* ── Mount ── без defer скрипт в <head> выполняется до <body> */
  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
`.trim();

  // Счёт выдачи (аудит 15.10, WID-measure): хост — из Referer, который
  // браузер шлёт сам (обычно только источник страницы партнёра). Не ждётся:
  // скрипт уходит партнёру при любом исходе записи, отказ — в лог с SQLSTATE.
  // Хост подделывается — сигнал для счёта, а не замок.
  void recordWidgetServed(pool, p.id, hostFromReferer(request.headers.get('referer')), request.headers.get('user-agent'));

  const origin = request.headers.get('origin');
  return new NextResponse(js, { headers: corsHeaders(origin, p.widget_domains) });
}
