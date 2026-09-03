-- migrations/929_close_synthetic_sos_from_smoke.sql
--
-- Закрыть два SOS от 02.09.2026, которые послали мы сами.
--
-- Перепись /api/cron/sos-census: за 90 дней два сигнала, оба curl/8.5.0, оба
-- с адресов Azure (74.235.134.163, 20.120.156.218), без имени, телефона,
-- координат, типа, сообщения, сессии и авторизации. Прогоны
-- .github/workflows/perimeter-smoke.yml — 06:05:05Z и 11:44:37Z; сигналы —
-- 06:05:14Z и 11:44:51Z. Smoke-тест периметра бил `POST {}` в живой
-- приёмник, ожидая 400; приёмник по замыслу принимает пустое тело.
--
-- Это ЛОЖНАЯ ТРЕВОГА с известным источником — не «неустановленный», и не
-- «никто не ответил». Поэтому outcome = 'false_alarm', а не
-- unknown_no_response: мы знаем, что случилось, и говорим это прямо.
--
-- Условия сужены до улики, а не до «всё пустое от curl»: пустой сигнал от
-- настоящего человека закрывать этой миграцией нельзя. Идемпотентно: второй
-- прогон не найдёт строк.

UPDATE sos_events
   SET status  = 'false_alarm',
       outcome = 'false_alarm',
       outcome_at = NOW(),
       origin_class = COALESCE(origin_class, 'unattributed'),
       notes = COALESCE(notes || ' | ', '')
               || 'Закрыт миграцией 929: сигнал послал наш perimeter-smoke.yml '
               || '(curl с раннера GitHub, секунда в секунду с прогоном). '
               || 'Проверка переведена на GET без сигнала.'
 WHERE status = 'sent'
   AND created_at >= '2026-09-02 00:00:00+00'
   AND created_at <  '2026-09-03 00:00:00+00'
   AND user_agent = 'curl/8.5.0'
   AND host(ip_address) IN ('74.235.134.163', '20.120.156.218')
   AND user_id IS NULL
   AND session_id IS NULL
   AND lat IS NULL AND lng IS NULL
   AND COALESCE(tourist_name, '') = ''
   AND COALESCE(tourist_phone, '') = ''
   AND COALESCE(emergency_type, '') = ''
   AND COALESCE(message, '') = '';
