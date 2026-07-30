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

  /* Текст прогресса поиска по числу секунд — общий для обоих экранов. */
  function progressLabel(seconds) {
    if (seconds <= 0) return 'Определяем GPS…';
    if (seconds <= 10) return 'Определяем GPS… ' + seconds + ' сек';
    if (seconds <= 25) return 'Слабый сигнал — выйди на открытое место (' + seconds + ' сек)';
    return 'Очень долго — нажми «Повторить» и выйди на открытое место';
  }

  /*
   * Локатор: одна оркестрация поиска для обоих экранов.
   *
   * Эмитит состояния через onState:
   *   { phase: 'locating', seconds }             — идёт поиск, тикает секундами
   *   { phase: 'found', seconds, coords }        — координаты получены
   *   { phase: 'error', seconds, error }         — отказ с человеческой причиной
   *
   * Сначала строгий getCurrentPosition с кешем до 5 мин (мгновенный ответ,
   * если телефон уже знает где он), при отказе — мягкий watchPosition. Так же,
   * как это делает честный /emergency; /sos раньше делал одну попытку и сдавался.
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
    var seconds = 0;
    var done = false;
    var generation = 0;

    function clearTimers() {
      if (timer) { clearInterval(timer); timer = null; }
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      if (watchId != null && geo) { try { geo.clearWatch(watchId); } catch (e) {} watchId = null; }
    }

    function start() {
      clearTimers();
      var myGen = ++generation;
      done = false;
      seconds = 0;

      // true, если этот callback принадлежит уже отменённой попытке.
      function stale() { return myGen !== generation; }

      function success(position) {
        if (done || stale()) return;
        done = true;
        clearTimers();
        onState({
          phase: 'found',
          seconds: seconds,
          coords: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            acc: position.coords.accuracy,
            timestamp: position.timestamp || null
          }
        });
      }

      function fail(err) {
        if (done || stale()) return;
        done = true;
        clearTimers();
        onState({ phase: 'error', seconds: seconds, error: describeError(err && err.code) });
      }

      if (!geo) {
        done = true;
        onState({ phase: 'error', seconds: 0, error: describeError('unsupported') });
        return;
      }

      onState({ phase: 'locating', seconds: 0 });
      timer = setInterval(function () {
        if (done || stale()) return;
        seconds++;
        onState({ phase: 'locating', seconds: seconds });
      }, 1000);

      geo.getCurrentPosition(
        success,
        function (firstErr) {
          if (done || stale()) return;
          // Отказ в разрешении повтором не лечится — не ждём 30 сек впустую.
          if (firstErr && firstErr.code === 1) { fail(firstErr); return; }
          // Строгая попытка не удалась — переключаемся на менее строгий watch.
          try {
            watchId = geo.watchPosition(
              success,
              function () { /* ждём hardTimer, а не рвём поиск на первой ошибке watch */ },
              { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 }
            );
          } catch (e) { /* watch не поддержан — упадём в fail по таймеру */ }
          hardTimer = setTimeout(function () { if (!done && !stale()) fail(firstErr); }, 30000);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
      );
    }

    return { start: start, retry: start, stop: clearTimers };
  }

  var API = {
    LAST_POS_KEY: LAST_POS_KEY,
    MAX_AGE_MS: MAX_AGE_MS,
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
