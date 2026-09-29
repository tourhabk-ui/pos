/**
 * Виджет партнёра Ведар AI — скрипт встраивания
 *
 * Usage on partner site:
 * <script defer src="https://vedarai.ru/widget/embed.js"
 *         data-partner-id="fishingkam"
 *         data-theme="light"
 *         data-position="right"
 *         data-color="#003466"
 *         data-bottom="120">
 * </script>
 *
 * defer обязателен при вставке в <head>: без него скрипт выполняется до
 * появления <body> и падает на appendChild (примерка на fishingkam.ru 29.09).
 * На случай вставки без defer монтирование всё равно ждёт DOMContentLoaded.
 *
 * data-color  — цвет кнопки под сайт партнёра (#RGB / #RRGGBB), иначе акцент Ведара.
 * data-bottom — отступ снизу в px (0–400): у партнёра в углу бывают свои
 *               плашки (cookie, «Связаться с нами»), и кнопка не должна их
 *               закрывать. По умолчанию 20.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var partnerId = script.getAttribute('data-partner-id');
  if (!partnerId) {
    console.warn('[Ведар AI] не задан data-partner-id');
    return;
  }

  var theme = script.getAttribute('data-theme') || 'light';
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var colorAttr = script.getAttribute('data-color') || '';
  var bottomAttr = parseInt(script.getAttribute('data-bottom') || '', 10);
  var bottom = isNaN(bottomAttr) ? 20 : Math.max(0, Math.min(400, bottomAttr));
  var baseUrl = script.src.replace(/\/widget\/embed\.js.*$/, '');

  // Цвет — только hex: значение уходит в CSS, и произвольная строка из
  // атрибута не должна дописывать туда свои правила.
  var accent = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colorAttr) ? colorAttr : '#D44A0C';

  function mount() {
  // Prevent double-init
  if (document.getElementById('tourhub-widget-root')) return;

  // Styles
  var css = document.createElement('style');
  css.textContent = [
    '#tourhub-widget-root{position:fixed;bottom:' + bottom + 'px;z-index:999999;font-family:system-ui,sans-serif}',
    position === 'left'
      ? '#tourhub-widget-root{left:20px}'
      : '#tourhub-widget-root{right:20px}',
    '#tourhub-widget-btn{width:56px;height:56px;border-radius:50%;border:none;background:' + accent + ';color:#fff;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s}',
    '#tourhub-widget-btn:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,0.25)}',
    '#tourhub-widget-btn svg{width:24px;height:24px}',
    // Высота не больше экрана: при большом data-bottom верх окна иначе уходит за экран.
    '#tourhub-widget-frame{position:absolute;bottom:70px;width:370px;height:520px;max-height:calc(100vh - ' + (bottom + 90) + 'px);border:none;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.18);opacity:0;transform:translateY(10px) scale(0.95);transition:opacity .25s,transform .25s;pointer-events:none;background:#fff}',
    position === 'left'
      ? '#tourhub-widget-frame{left:0}'
      : '#tourhub-widget-frame{right:0}',
    '#tourhub-widget-frame.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}',
    // Телефон: окно привязано к экрану, а не к кнопке. Прежнее left:50%
    // считалось от корня шириной 56 px, и окно уезжало на 125 px за правый
    // край экрана 390 px (примерка на fishingkam.ru 29.09).
    // Ширина задана явно: у iframe (замещаемый элемент) width:auto между
    // left и right не растягивается, а остаётся 300 px у левого края.
    '@media(max-width:420px){#tourhub-widget-frame{position:fixed;left:16px;right:16px;width:calc(100vw - 32px);bottom:' + (bottom + 70) + 'px;height:min(520px,calc(100vh - ' + (bottom + 100) + 'px))}}',
  ].join('\n');
  document.head.appendChild(css);

  // Root
  var root = document.createElement('div');
  root.id = 'tourhub-widget-root';

  // Chat icon SVG
  var chatIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Iframe
  var iframe = document.createElement('iframe');
  iframe.id = 'tourhub-widget-frame';
  // Адрес ставится при первом открытии, а не сразу: iframe на fixed-позиции
  // loading=lazy не откладывает, и чат грузился (с нашей аналитикой и
  // service worker) на каждый просмотр страницы партнёра без единого клика.
  var frameSrc = baseUrl + '/widget/' + encodeURIComponent(partnerId) + '?theme=' + encodeURIComponent(theme);
  iframe.title = 'Чат с помощником';

  // Button
  var btn = document.createElement('button');
  btn.id = 'tourhub-widget-btn';
  btn.innerHTML = chatIcon;
  btn.setAttribute('aria-label', 'Открыть чат');

  var isOpen = false;

  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    if (isOpen && !iframe.getAttribute('src')) iframe.setAttribute('src', frameSrc);
    if (isOpen) {
      iframe.classList.add('open');
      btn.innerHTML = closeIcon;
      btn.setAttribute('aria-label', 'Закрыть чат');
    } else {
      iframe.classList.remove('open');
      btn.innerHTML = chatIcon;
      btn.setAttribute('aria-label', 'Открыть чат');
    }
  });

  root.appendChild(iframe);
  root.appendChild(btn);
  document.body.appendChild(root);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
