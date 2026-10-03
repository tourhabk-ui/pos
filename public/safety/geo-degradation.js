/*
 * geo-degradation.js — единая семантика деградации геолокации для экстренных
 * экранов /sos и /emergency.
 *
 * Повод (issue #897): два экрана открываются офлайн, но деградируют по-разному.
 * /emergency различает причину отказа (code 1/2/3), пробует повторно и
 * показывает последнюю известную позицию с давностью; /sos показывал плоское
 * «Недоступны» и при этом ОБЕЩАЛ поиск по последней позиции, которой у него
 * не было. Разошлись потому, что реализованы дважды. Этот модуль — один
 * источник поведения для обоих.
 *
 * Ядро без DOM: работает с navigator.geolocation и localStorage, а рисует
 * состояние каждый экран сам (React на /sos, ванильный DOM на /emergency).
 * Поэтому его можно подключить и как <script> (кладёт API в window.VedarGeo),
 * и как CommonJS-модуль (module.exports) — последнее нужно юнит-тестам.
 *
 * ВАЖНО: файл лежит в CRITICAL_URLS precache (public/sw.js). /emergency
 * зависит от него офлайн — не выносить из критичного списка и бампать
 * CACHE_NAME при изменении содержимого.
 */
(function () {
  'use strict';

  var LAST_POS_KEY = 'vedar_last_online_pos';
  // Последняя онлайн-позиция старше суток бесполезна. Сравниваем по
  // миллисекундам, а не по округлённым минутам: округление пропустило бы
  // точку возрастом 24 ч + полминуты как «ещё свежую».
  var MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatAge(minsAgo) {
    if (minsAgo < 1) return 'только что';
    if (minsAgo < 60) return minsAgo + ' мин назад';
    return Math.round(minsAgo / 60) + ' ч назад';
  }

  /*
   * Последняя известная позиция — или null, если её реально нет. Единственная
   * точка входа к сохранённой точке: и текст, и карты обязаны читать только
   * отсюда, иначе на экран попадёт то, что валидатор отверг.
   *
   * null отдаётся честно во всех случаях, когда показывать точку было бы ложью:
   * ключа нет, JSON битый, координаты не числа/не конечны/вне диапазона широты
   * и долготы, метка из будущего (отрицательный возраст — не «самая свежая
   * точка», а недоступность) либо старше суток.
   */
  function readLastKnown(now, storage) {
    now = typeof now === 'number' ? now : Date.now();
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) return null;

    var raw;
    try { raw = storage.getItem(LAST_POS_KEY); } catch (e) { return null; }
    if (!raw) return null;

    var pos;
    try { pos = JSON.parse(raw); } catch (e) { return null; }
    if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number' || typeof pos.t !== 'number') {
      return null;
    }
    // Конечность и географически возможные диапазоны — иначе на карту попала бы
    // невозможная точка в обход контракта.
    if (!isFinite(pos.lat) || !isFinite(pos.lng) || !isFinite(pos.t)) return null;
    if (pos.lat < -90 || pos.lat > 90 || pos.lng < -180 || pos.lng > 180) return null;

    var ageMs = now - pos.t;
    if (ageMs < 0) return null;         // метка из будущего — недоступно, не «только что»
    if (ageMs > MAX_AGE_MS) return null; // старше суток — бесполезно (сравнение по мс)
    var minsAgo = Math.round(ageMs / 60000);

    return {
      lat: pos.lat,
      lng: pos.lng,
      acc: typeof pos.acc === 'number' ? pos.acc : null,
      t: pos.t,
      minsAgo: minsAgo,
      ageLabel: formatAge(minsAgo)
    };
  }

  /*
   * Дополняет последнюю позицию расстоянием от текущей, когда текущая
   * известна. Мутирует и возвращает переданный объект (или null).
   */
  function attachDistance(lastKnown, curLat, curLng) {
    if (!lastKnown) return lastKnown;
    if (typeof curLat === 'number' && typeof curLng === 'number') {
      var d = haversineKm(curLat, curLng, lastKnown.lat, lastKnown.lng);
      lastKnown.distanceKm = d;
      lastKnown.distanceLabel = d < 1 ? (Math.round(d * 1000) + ' м') : (d.toFixed(1) + ' км');
    }
    return lastKnown;
  }

  /*
   * Причина отказа GPS — человеческая, а не «Недоступны». retryable говорит
   * экрану, есть ли смысл в кнопке «Повторить»: при отказе в разрешении
   * повтор не поможет, поможет только настройка браузера.
   */
  function describeError(code) {
    switch (code) {
      case 1:
        return { code: 1, reason: 'Нет разрешения на геолокацию', hint: 'Разреши геолокацию в настройках браузера', retryable: false };
      case 2:
        return { code: 2, reason: 'Нет сигнала GPS', hint: 'Выйди на открытое место и нажми «Повторить»', retryable: true };
      case 3:
        return { code: 3, reason: 'Спутники не найдены за отведённое время', hint: 'Нажми «Повторить» или выйди на открытое место', retryable: true };
      case 'unsupported':
        return { code: 'unsupported', reason: 'GPS не поддерживается устройством', hint: 'Позвони 112 и назови ориентиры на местности', retryable: false };
      default:
        return { code: 0, reason: 'GPS недоступен', hint: 'Позвони 112 напрямую', retryable: true };
    }
  }

  /*
   * Точность словами — общая для обоих экранов. Грубая точка по вышке без
   * этой приписки выглядела бы такой же уверенной, как спутниковая, и
   * диспетчер 112 искал бы человека в круге километр, думая, что в метрах.
   */
  function accuracyLabel(acc, refining) {
    if (typeof acc !== 'number' || !isFinite(acc)) return refining ? 'точность неизвестна — уточняем' : 'точность неизвестна';
    var m = acc >= 1000 ? (Math.round(acc / 100) / 10) + ' км' : Math.round(acc) + ' м';
    return '±' + m + (refining ? ' — уточняем' : '');
  }

  /* Текст прогресса поиска по числу секунд — общий для обоих экранов. */
  function progressLabel(seconds) {
    if (seconds <= 0) return 'Определяем GPS…';
    if (seconds <= 10) return 'Определяем GPS… ' + seconds + ' сек';
    if (seconds <= 25) return 'Слабый сигнал — выйди на открытое место (' + seconds + ' сек)';
    return 'Очень долго — нажми «Повторить» и выйди на открытое место';
  }

  /*
   * Точность, при которой уточнять дальше незачем: спутниковый фикс под
   * открытым небом. Достигли — слежение снимается (батарея в поле дороже).
   */
  var GOOD_ACC_M = 25;
  /* Сколько уточнять после первой точки, если хорошей точности так и нет. */
  var REFINE_MS = 60000;
  /* Сколько ждать хоть какой-то точки, прежде чем назвать причину отказа. */
  var HARD_TIMEOUT_MS = 30000;
  /*
   * Точка старше этого — «последняя известная», а не «где я сейчас»
   * (03.10, второй снимок владельца: «координаты должны ставиться моментально,
   * как у других навигаторов» — 13 с «Слабый сигнал» и ни одной точки).
   */
  var FRESH_MS = 60000;

  /*
   * Локатор: одна оркестрация поиска для обоих экранов.
   *
   * Эмитит состояния через onState:
   *   { phase: 'locating', seconds }                       — идёт поиск, тикает секундами
   *   { phase: 'found', seconds, coords, refining }        — координаты получены;
   *                                                          refining — ещё уточняем
   *   { phase: 'error', seconds, error }                   — отказ с человеческой причиной
   *
   * Два запроса СРАЗУ, а не по очереди (скрин владельца 03.10: «очень долго
   * определяет координаты, почему другие приложения делают это моментально?»).
   * Прежде строгий спутниковый запрос ждал до 10 секунд, и только после его
   * отказа спрашивалась быстрая позиция — человек у SOS смотрел на «Слабый
   * сигнал» там, где телефон по вышкам и Wi-Fi знал место за секунду. Так,
   * как делают карты: быстрая грубая точка — сразу, с честной точностью
   * («±1200 м»), спутниковая — уточняет её следом. Каждая следующая точка
   * принимается, только если она ТОЧНЕЕ показанной: грубая вышка не
   * перетирает пришедший спутник.
   *
   * Модуль НЕ пишет позицию в localStorage: единственный writer точки —
   * components/tracking/LastPositionTracker (пишет при онлайн-геолокации на
   * обычных экранах). Здесь только чтение и валидация — чтобы не плодить второй
   * источник записи точных координат.
   *
   * Отказ в разрешении (code 1) не тянем через 30-секундный watch: повтор его
   * не лечит, честнее сразу сообщить причину. Каждый start() — новая «попытка»
   * с номером; поздний callback предыдущей попытки игнорируется (иначе старый
   * getCurrentPosition мог бы завершить свежий retry).
   */
  function createLocator(opts) {
    opts = opts || {};
    var onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    var geo = opts.geolocation || (typeof navigator !== 'undefined' ? navigator.geolocation : null);

    var watchId = null;
    var timer = null;
    var hardTimer = null;
    var refineTimer = null;
    var seconds = 0;
    var done = false;
    var generation = 0;

    function clearTimers() {
      if (timer) { clearInterval(timer); timer = null; }
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      if (refineTimer) { clearTimeout(refineTimer); refineTimer = null; }
      if (watchId != null && geo) { try { geo.clearWatch(watchId); } catch (e) {} watchId = null; }
    }

    function start() {
      clearTimers();
      var myGen = ++generation;
      done = false;
      seconds = 0;
      var best = null;      // показанная точка: { lat, lng, acc, timestamp }
      var lastErr = null;   // последняя причина отказа — для честного сообщения

      // true, если этот callback принадлежит уже отменённой попытке.
      function stale() { return myGen !== generation; }

      function emitFound(refining) {
        onState({ phase: 'found', seconds: seconds, refining: refining, coords: best });
      }

      // Уточнение закончено: хорошая точность или вышло время. Показанная
      // точка остаётся, слежение и таймеры снимаются.
      function finish() {
        if (done) return;
        done = true;
        clearTimers();
        if (best) emitFound(false);
      }

      function fix(position) {
        if (done || stale()) return;
        var c = position && position.coords;
        if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
        var acc = isFinite(c.accuracy) ? c.accuracy : Infinity;
        var ts = position.timestamp || null;
        // Свежесть — по времени самой точки: кеш браузера отдаёт её с меткой
        // того момента, когда она была снята.
        var fresh = ts == null || (Date.now() - ts) <= FRESH_MS;
        if (best) {
          // Свежая точка всегда заменяет старую из кеша, даже если грубее:
          // старая могла быть снята в другом месте. Среди равных по свежести —
          // только точнее: вышка не перетирает спутник.
          var replace = (fresh && !best.fresh) || (fresh === best.fresh && acc < best.acc);
          if (!replace) return;
        }
        var first = !best;
        best = { lat: c.latitude, lng: c.longitude, acc: acc, timestamp: ts, fresh: fresh };
        if (first) {
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          if (timer) { clearInterval(timer); timer = null; }
          refineTimer = setTimeout(function () { if (!stale()) finish(); }, REFINE_MS);
        }
        // Завершает только СВЕЖАЯ точная точка: старая из кеша могла быть
        // точной там, где человека уже нет.
        if (fresh && acc <= GOOD_ACC_M) { finish(); return; }
        emitFound(true);
      }

      function fail(err) {
        if (done || stale()) return;
        done = true;
        clearTimers();
        onState({ phase: 'error', seconds: seconds, error: describeError(err && err.code) });
      }

      function soft(err) {
        if (done || stale()) return;
        // Отказ в разрешении повтором и ожиданием не лечится — сразу причина.
        if (err && err.code === 1) { fail(err); return; }
        lastErr = err || lastErr;
        // Прочие отказы ждут: второй запрос ещё может ответить (hardTimer).
      }

      if (!geo) {
        done = true;
        onState({ phase: 'error', seconds: 0, error: describeError('unsupported') });
        return;
      }

      onState({ phase: 'locating', seconds: 0 });
      timer = setInterval(function () {
        if (done || stale() || best) return;
        seconds++;
        onState({ phase: 'locating', seconds: seconds });
      }, 1000);

      // Мгновенная: последняя точка, которую браузер уже знает, любой
      // давности — так навигаторы показывают место сразу. Кеша нет — отказ
      // за секунду, и он ничего не решает (soft). Показывается с возрастом
      // («N мин назад») и сменяется первой свежей точкой.
      geo.getCurrentPosition(fix, soft,
        { enableHighAccuracy: false, timeout: 1000, maximumAge: Infinity });
      // Быстрая: вышки и Wi-Fi, кеш до 5 минут — за секунду, если телефон
      // хоть что-то знает о месте.
      geo.getCurrentPosition(fix, soft,
        { enableHighAccuracy: false, timeout: HARD_TIMEOUT_MS, maximumAge: 300000 });
      // Точная: спутники, уточняет быструю по мере прихода.
      try {
        watchId = geo.watchPosition(fix, soft,
          { enableHighAccuracy: true, timeout: HARD_TIMEOUT_MS, maximumAge: 0 });
      } catch (e) { /* watch не поддержан — остаётся быстрая */ }
      hardTimer = setTimeout(function () {
        if (!done && !stale() && !best) fail(lastErr || { code: 3 });
      }, HARD_TIMEOUT_MS);
    }

    return { start: start, retry: start, stop: clearTimers };
  }

  var API = {
    LAST_POS_KEY: LAST_POS_KEY,
    MAX_AGE_MS: MAX_AGE_MS,
    GOOD_ACC_M: GOOD_ACC_M,
    REFINE_MS: REFINE_MS,
    HARD_TIMEOUT_MS: HARD_TIMEOUT_MS,
    FRESH_MS: FRESH_MS,
    accuracyLabel: accuracyLabel,
    haversineKm: haversineKm,
    formatAge: formatAge,
    readLastKnown: readLastKnown,
    attachDistance: attachDistance,
    describeError: describeError,
    progressLabel: progressLabel,
    createLocator: createLocator
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.VedarGeo = API;
})();
