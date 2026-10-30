-- 1343: снимки 34 туров «Лагуны Экспедиции» и её логотип.
--
-- ── Основание — слово владельца 29.10 ─────────────────────────────────────
-- На вопрос «почему у Лагуны экспедиции фото не загружены» владелец ответил:
-- «они дали добро на использоваеие» и «и логотип». Снимки и логотип берутся с
-- сайта оператора сейчас — тем же порядком, что 1338 взяла снимки гида по
-- слову владельца («фото согласие он мне дал»). Где хранить — правило §4.1
-- (решение владельца 18.09: байтам фотографии в базе не место); 29.10
-- владелец спросил «фото в s3?» — да, в хранилище.
-- Записанного согласия партнёра (partner_material_consents, 1321) пока НЕТ:
-- его партнёр подписывает сам по ссылке /partner-consent, администратор за
-- него согласие не пишет. Это остаётся открытым пунктом, и строки «партнёр
-- разрешил … — согласие от …» на его странице до подписи не будет. В тот же
-- пункт — показать партнёру итоговый знак: логотип здесь не его файл, а
-- переделка (белые буквы на сером круге, ниже), и текст согласия (1321) о
-- логотипе говорит только «уменьшает» — подложку и перекраску он не
-- называет. Либо партнёр видит и принимает знак на круге, либо текст
-- согласия называет подложку.
--
-- ── Откуда снимки ─────────────────────────────────────────────────────────
-- Со страниц туров laguna-expedition.ru/tours/<id>-<адрес> — та же страница,
-- что в source_url каждого тура (1339), снято 29.10.2026. У трёх туров
-- страница на сайте в архиве («Тур находится в архиве»), и оригиналы отвечают
-- 404: «Дачные горячие источники на внедорожнике Tank-300», «К Гамулам на
-- Вилючинский перевал на внедорожнике Tank-300» и «Каньон Опасный + Дачные
-- источники на вездеходе Sever Truck» — их кадры взяты из превью того же
-- сайта, 960×640. Стоят ли эти туры на витрине — вопрос оператору, не этой
-- миграции.
--
-- Всего с 34 страниц разобрано глазами 282 кадра. Взято 147 (обложка и до
-- пяти в галерею у каждого тура), 24 годных оставлены запасом — галерея не
-- длиннее пяти кадров, — отброшено 111:
--   • 55 — повторы и почти-повторы (тот же вид, тот же день, тот же ракурс);
--   • 17 — слабее отобранных или сверх пяти кадров: мелкий файл, блики
--     объектива, палец в кадре, парковка без маршрута, непонятная постройка;
--   • 21 — люди главные в кадре: узнаваемые лица крупным планом, группы,
--     позирующие в камеру, ребёнок; записанного согласия изображённых нет.
--     Исключений нет ни для исполнителей этнопрограммы (портрет с бубном,
--     двое у костра), ни для туристов в нарте и за столом: пять таких кадров
--     сняты на ревью 29.10, и у «Духа Камчатки» осталась одна обложка, у
--     «Двух вулканов» — нарта со снегоходом без людей;
--   • 8 — кадр обещает то, чего в программе нет: катание на упряжке, Дед
--     Мороз, тюбинг, восхождение на Горелый, вертолёт, летний пляж в зимнем
--     туре;
--   • 8 — текст и реклама поверх смысла: баннер «ВСЁ ВКЛЮЧЕНО», открытка с
--     надписью, коллаж полароидов, крупная реклама производителя вездехода
--     с адресом его сайта (один и тот же кадр двери у визит-центра — во всех
--     трёх турах, где он стоял, у «Часовой прогулки» снят на ревью 29.10);
--   • 1 — авторство под сомнением (краб на палубе чужого судна, похоже на
--     репортажный снимок); вернуть можно, если оператор подтвердит, что он его;
--   • 1 — кладбище посёлка на первом плане.
-- Ливрея производителя на борту вездехода, на котором едет тур, — часть
-- машины, а не знак поверх снимка: кадр, где машина видна целиком на
-- маршруте, оставлен (не обложкой, если надпись крупная). Кадр, где дверь с
-- адресом сайта и аккаунтом занимает пол-кадра, а маршрута нет, — реклама.
--
-- ── Как хранятся ──────────────────────────────────────────────────────────
-- Байтов в базе и в образе нет (§4.1, решение владельца 18.09). Кадры пережаты
-- до 1600 px по длинной стороне, JPEG 82, метаданные сняты (у части снимков
-- в EXIF были координаты места съёмки), и лежат в media/s3/photos/
-- laguna-expedition/ — 133 файла, 34 МБ; одинаковые файлы разных туров
-- залиты один раз (у части туров оператор ставит одни и те же кадры: маршрут
-- у них общий). В хранилище их кладёт media-to-s3.yml по маркеру
-- .github/triggers/media-to-s3.json (прогон 17) с чтением обратно; в туре
-- лежит адрес /api/images/s3/photos/laguna-expedition/<файл>.jpg — сервер
-- отвечает редиректом на объект (lib/images/photo-key). Варианты WebP для них
-- не режутся: карточки берут адрес как есть.
--
-- Логотип — исключение: маленький PNG в public/images/laguna-expedition/, как
-- у «Лагуны Прокат» (1320), потому что раздача /api/images/s3/ отдаёт только
-- .jpg. Источник — векторный знак шапки сайта (laguna-expedition.ru/images/
-- favicon.svg, «ЛАГУНА экспедиция»): контуры букв те же, буквы белые, как в
-- шапке сайта (logo_p47419.png), на круге фирменного серого #525152 из того же
-- файла, 512×512 с прозрачными углами. Круг — потому что карточка тура
-- показывает логотип в круге, а страница оператора — на чёрной подложке:
-- серый знак сайта на чёрном не читался бы, белый на светлом круге — тоже.
--
-- ── Что пишет миграция ────────────────────────────────────────────────────
--   • туру — tour_image = обложка, photos = обложка и галерея по порядку
--     (так читают карточка, каталог и главная: lib/tours/hero-image), и только
--     туру «Лагуны Экспедиции», у которого снимков нет вовсе: ни одного
--     непустого адреса в photos и пустая обложка. Что поставил оператор или
--     администратор, не перетирается;
--   • партнёру — подпись «Лагуна Экспедиция» в gallery_credits для каждого
--     адреса из этого набора, который стоит у его туров (карточка тура пишет
--     «Фото: Лагуна Экспедиция»); записанная прежде подпись того же адреса
--     остаётся;
--   • логотип — только если logo_image пуст.
--
-- Идемпотентна, без BEGIN/COMMIT. Повтор ничего не меняет. Исход — WARNING в
-- конце: нет карточки, у туров не те снимки, логотип не встал.

WITH v(slug, photos) AS (VALUES
  ('lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-1.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-2.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-3.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-4.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-5.jpg'
   ]::text[]),
  ('lagexp-na-kraj-sveta-mys-mayachnyj', ARRAY[
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-1.jpg',
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-2.jpg',
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-3.jpg',
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-4.jpg',
     '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-5.jpg'
   ]::text[]),
  ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh', ARRAY[
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-1.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-2.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-3.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-4.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-5.jpg'
   ]::text[]),
  ('lagexp-k-gamulam-na-vilyuchinskij-pereval', ARRAY[
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-1.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-2.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-3.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-4.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-5.jpg'
   ]::text[]),
  ('lagexp-siti-tur-tuda-gde-vstaet-solntse', ARRAY[
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-1.jpg',
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-2.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-3.jpg',
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-4.jpg',
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-5.jpg'
   ]::text[]),
  ('lagexp-konnaya-progulka', ARRAY[
     '/api/images/s3/photos/laguna-expedition/konnaya-progulka-cover.jpg'
   ]::text[]),
  ('lagexp-karymshinskie-termalnye-istochniki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-1.jpg',
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-2.jpg',
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-3.jpg',
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-4.jpg',
     '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-5.jpg'
   ]::text[]),
  ('lagexp-pervyj-rassvet', ARRAY[
     '/api/images/s3/photos/laguna-expedition/pervyj-rassvet-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/pervyj-rassvet-1.jpg',
     '/api/images/s3/photos/laguna-expedition/pervyj-rassvet-2.jpg',
     '/api/images/s3/photos/laguna-expedition/pervyj-rassvet-3.jpg'
   ]::text[]),
  ('lagexp-mys-mayachnyj', ARRAY[
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-1.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-2.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-3.jpg'
   ]::text[]),
  ('lagexp-chasovaya-progulka', ARRAY[
     '/api/images/s3/photos/laguna-expedition/chasovaya-progulka-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/chasovaya-progulka-1.jpg',
     '/api/images/s3/photos/laguna-expedition/chasovaya-progulka-2.jpg'
   ]::text[]),
  ('lagexp-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck', ARRAY[
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vezdekhode-sever-truck-1.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vezdekhode-sever-truck-2.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vezdekhode-sever-truck-3.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vezdekhode-sever-truck-4.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vezdekhode-sever-truck-5.jpg'
   ]::text[]),
  ('lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300', ARRAY[
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-1.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-2.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-3.jpg'
   ]::text[]),
  ('lagexp-k-gamulam-na-vilyuchinskij-pereval-na-vnedorozhnike-tank-300', ARRAY[
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-3.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-1.jpg',
     '/api/images/s3/photos/laguna-expedition/dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300-2.jpg'
   ]::text[]),
  ('lagexp-khalaktyrskij-plyazh', ARRAY[
     '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-2.jpg',
     '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-3.jpg',
     '/api/images/s3/photos/laguna-expedition/khalaktyrskij-plyazh-2.jpg',
     '/api/images/s3/photos/laguna-expedition/khalaktyrskij-plyazh-3.jpg',
     '/api/images/s3/photos/laguna-expedition/khalaktyrskij-plyazh-4.jpg'
   ]::text[]),
  ('lagexp-v-gosti-k-evrazhkam-na-avachinskij-pereval', ARRAY[
     '/api/images/s3/photos/laguna-expedition/v-gosti-k-evrazhkam-na-avachinskij-pereval-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/v-gosti-k-evrazhkam-na-avachinskij-pereval-1.jpg',
     '/api/images/s3/photos/laguna-expedition/v-gosti-k-evrazhkam-na-avachinskij-pereval-2.jpg',
     '/api/images/s3/photos/laguna-expedition/v-gosti-k-evrazhkam-na-avachinskij-pereval-3.jpg',
     '/api/images/s3/photos/laguna-expedition/v-gosti-k-evrazhkam-na-avachinskij-pereval-4.jpg'
   ]::text[]),
  ('lagexp-kanon-opasnyj', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-2.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-4.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-5.jpg'
   ]::text[]),
  ('lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya', ARRAY[
     '/api/images/s3/photos/laguna-expedition/obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya-1.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya-2.jpg'
   ]::text[]),
  ('lagexp-pitomnik-ezdovykh-sobak-snezhnye-psy', ARRAY[
     '/api/images/s3/photos/laguna-expedition/pitomnik-ezdovykh-sobak-snezhnye-psy-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/pitomnik-ezdovykh-sobak-snezhnye-psy-1.jpg',
     '/api/images/s3/photos/laguna-expedition/pitomnik-ezdovykh-sobak-snezhnye-psy-2.jpg',
     '/api/images/s3/photos/laguna-expedition/pitomnik-ezdovykh-sobak-snezhnye-psy-3.jpg',
     '/api/images/s3/photos/laguna-expedition/pitomnik-ezdovykh-sobak-snezhnye-psy-4.jpg'
   ]::text[]),
  ('lagexp-dukh-kamchatki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/dukh-kamchatki-cover.jpg'
   ]::text[]),
  ('lagexp-kamchatka-na-maksimum-osennij-marshrut', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-2.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-4.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-5.jpg'
   ]::text[]),
  ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck', ARRAY[
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck-1.jpg',
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck-2.jpg'
   ]::text[]),
  ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval', ARRAY[
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck-2.jpg',
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-1.jpg',
     '/api/images/s3/photos/laguna-expedition/vodopad-snezhnyj-bars-vilyuchinskij-pereval-2.jpg'
   ]::text[]),
  ('lagexp-novyj-god-na-kamchatke', ARRAY[
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-1.jpg',
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-2.jpg',
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-3.jpg',
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-4.jpg',
     '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-5.jpg'
   ]::text[]),
  ('lagexp-krabovoe-safari-v-avachinskoj-bukhte', ARRAY[
     '/api/images/s3/photos/laguna-expedition/krabovoe-safari-v-avachinskoj-bukhte-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/krabovoe-safari-v-avachinskoj-bukhte-1.jpg'
   ]::text[]),
  ('lagexp-zelenovskie-ozerki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/zelenovskie-ozerki-cover.jpg'
   ]::text[]),
  ('lagexp-dva-vulkana-avachinskij-pereval', ARRAY[
     '/api/images/s3/photos/laguna-expedition/dva-vulkana-avachinskij-pereval-2.jpg',
     '/api/images/s3/photos/laguna-expedition/dva-vulkana-avachinskij-pereval-3.jpg'
   ]::text[]),
  ('lagexp-pogruzhenie-v-kulturu-severa', ARRAY[
     '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-1.jpg',
     '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-3.jpg',
     '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-4.jpg',
     '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-5.jpg'
   ]::text[]),
  ('lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck-2.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck-4.jpg'
   ]::text[]),
  ('lagexp-obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-1.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-2.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-3.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-4.jpg',
     '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-5.jpg'
   ]::text[]),
  ('lagexp-okhotskoe-more', ARRAY[
     '/api/images/s3/photos/laguna-expedition/okhotskoe-more-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/okhotskoe-more-1.jpg',
     '/api/images/s3/photos/laguna-expedition/okhotskoe-more-2.jpg',
     '/api/images/s3/photos/laguna-expedition/okhotskoe-more-3.jpg',
     '/api/images/s3/photos/laguna-expedition/okhotskoe-more-4.jpg'
   ]::text[]),
  ('lagexp-kamchatka-termalnyj-marshrut', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kamchatka-termalnyj-marshrut-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/zelenovskie-ozerki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-termalnyj-marshrut-3.jpg',
     '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-3.jpg',
     '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-3.jpg'
   ]::text[]),
  ('lagexp-novogodnie-vulkany-kamchatki-laguna-4', ARRAY[
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-laguna-4-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-laguna-4-1.jpg'
   ]::text[]),
  ('lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-laguna-4-1.jpg',
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki-2.jpg',
     '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki-3.jpg'
   ]::text[]),
  ('lagexp-k-domashnim-vulkanam-na-vezdekhode-sever-truck', ARRAY[
     '/api/images/s3/photos/laguna-expedition/k-domashnim-vulkanam-na-vezdekhode-sever-truck-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/k-domashnim-vulkanam-na-vezdekhode-sever-truck-1.jpg',
     '/api/images/s3/photos/laguna-expedition/k-domashnim-vulkanam-na-vezdekhode-sever-truck-2.jpg',
     '/api/images/s3/photos/laguna-expedition/k-domashnim-vulkanam-na-vezdekhode-sever-truck-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-osennij-marshrut-1.jpg'
   ]::text[])
)
UPDATE operator_tours t
   SET photos = v.photos,
       tour_image = v.photos[1],
       updated_at = NOW()
  FROM v, partners p
 WHERE t.slug = v.slug
   AND p.slug = 'laguna-expedition'
   AND p.id::text = t.operator_id::text
   AND NULLIF(btrim(t.tour_image), '') IS NULL
   AND NOT EXISTS (SELECT 1 FROM unnest(t.photos) AS x(u) WHERE NULLIF(btrim(x.u), '') IS NOT NULL);

-- Подпись снимков: каждый адрес набора, стоящий у туров партнёра. Записанное
-- прежде (в том числе другая подпись того же адреса) — справа и побеждает.
UPDATE partners p
   SET gallery_credits = s.merged,
       updated_at = NOW()
  FROM (
    SELECT p2.id,
           COALESCE((
             SELECT jsonb_object_agg(u.url, 'Лагуна Экспедиция')
               FROM (SELECT DISTINCT x.url
                       FROM operator_tours t, unnest(t.photos) AS x(url)
                      WHERE t.operator_id::text = p2.id::text
                        AND x.url LIKE '/api/images/s3/photos/laguna-expedition/%') u
           ), '{}'::jsonb) || COALESCE(p2.gallery_credits, '{}'::jsonb) AS merged
      FROM partners p2
     WHERE p2.slug = 'laguna-expedition'
  ) s
 WHERE p.id::text = s.id::text
   AND s.merged IS DISTINCT FROM COALESCE(p.gallery_credits, '{}'::jsonb);

UPDATE partners
   SET logo_image = '/images/laguna-expedition/laguna-expedition-logo.png',
       updated_at = NOW()
 WHERE slug = 'laguna-expedition'
   AND NULLIF(btrim(logo_image), '') IS NULL;

DO $$
DECLARE
  v_p      int;
  v_ours   int;
  v_bare   int;
  v_logo   text;
BEGIN
  SELECT count(*) INTO v_p FROM partners WHERE slug = 'laguna-expedition';
  IF v_p <> 1 THEN
    RAISE WARNING '[1343] карточек laguna-expedition: % (нужна одна, её заводит 1323) — снимки и логотип не поставлены', v_p;
    RETURN;
  END IF;
  SELECT count(*) FILTER (WHERE t.tour_image LIKE '/api/images/s3/photos/laguna-expedition/%'),
         count(*) FILTER (WHERE NULLIF(btrim(t.tour_image), '') IS NULL
                            AND NOT EXISTS (SELECT 1 FROM unnest(t.photos) AS x(u) WHERE NULLIF(btrim(x.u), '') IS NOT NULL))
    INTO v_ours, v_bare
    FROM operator_tours t JOIN partners p ON p.id::text = t.operator_id::text
   WHERE p.slug = 'laguna-expedition' AND t.slug LIKE 'lagexp-%' AND t.deleted_at IS NULL;
  IF v_ours <> 34 THEN
    RAISE WARNING '[1343] у «Лагуны Экспедиции» % туров со снимками этого набора, ожидалось 34 (тура нет — 1339 не прошла, или снимки уже поставил кто-то другой)', v_ours;
  END IF;
  IF v_bare > 0 THEN
    RAISE WARNING '[1343] у «Лагуны Экспедиции» % туров без единого снимка', v_bare;
  END IF;
  SELECT logo_image INTO v_logo FROM partners WHERE slug = 'laguna-expedition';
  IF NULLIF(btrim(v_logo), '') IS NULL THEN
    RAISE WARNING '[1343] логотип «Лагуны Экспедиции» не стоит';
  END IF;
END $$;
