-- 1468: утверждённые маршруты природных парков «Налычево», «Быстринский»,
-- «Вилючинский» (КГБУ «Природный парк «Вулканы Камчатки»). Слово владельца
-- 20.11: «Сверка и пометка».
--
-- Источник — страница парка «Туристические маршруты»
-- (https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/), прочитана 20.11.2026.
-- Парк пишет: «Передвижение по территории природных парков возможно только
-- по утвержденным маршрутам». Каждая строка — вариант маршрута (лето, зима или
-- всесезонный) словами страницы: период, способ передвижения, паспорт PDF,
-- трек. Пустое на странице — NULL, а не догадка.
--
-- Статус «открыт / закрыт» сюда не пишется: он меняется, и его читает
-- отдельный слой (следующий PR), а не эта миграция.
--
-- Связь с нашими маршрутами — park_approved_route_links, по slug маршрута,
-- сверенная по началу, концу и объекту (поиск и карточка маршрута на
-- витрине, 20.11), а не по похожести имени. Маршрута с таким slug нет —
-- строка связи не пишется. Идемпотентна: повтор ничего не меняет.

CREATE TABLE IF NOT EXISTS park_approved_routes (
  id            BIGSERIAL PRIMARY KEY,
  park_slug     VARCHAR(64) NOT NULL REFERENCES parks(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  title         TEXT NOT NULL,
  season        VARCHAR(8) NOT NULL CHECK (season IN ('summer', 'winter', 'all')),
  period        TEXT,
  movement      TEXT,
  passport_urls TEXT[] NOT NULL DEFAULT '{}',
  track_url     TEXT,
  source_url    TEXT NOT NULL,
  read_on       DATE NOT NULL,
  UNIQUE (park_slug, title, season)
);

COMMENT ON TABLE park_approved_routes IS
  'Утверждённые маршруты природных парков по странице парка «Туристические маршруты»; вариант — сезон. Пустое на странице — NULL.';

CREATE TABLE IF NOT EXISTS park_approved_route_links (
  approved_route_id BIGINT NOT NULL REFERENCES park_approved_routes(id) ON DELETE CASCADE,
  route_id          UUID NOT NULL REFERENCES kamchatka_routes(id) ON DELETE CASCADE,
  checked_note      TEXT NOT NULL CHECK (length(checked_note) >= 8),
  PRIMARY KEY (approved_route_id, route_id)
);

CREATE INDEX IF NOT EXISTS idx_park_approved_route_links_route ON park_approved_route_links (route_id);

COMMENT ON TABLE park_approved_route_links IS
  'Наш маршрут — тот же путь, что утверждённый маршрут парка. checked_note — чем сверено (старт, финиш, объект).';

INSERT INTO park_approved_routes (park_slug, title, season, period, movement, passport_urls, track_url, source_url, read_on)
SELECT v.park_slug, v.title, v.season, v.period, v.movement, v.passport_urls, v.track_url, v.source_url, DATE '2026-11-20'
  FROM (VALUES
  ('nalychevo', 'Пиначево — Центральный', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_1_pinachevo-central_nyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/1_pinachevo-central_nyj.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Пиначево — Центральный', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_1_pinachevo-central_nyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/1_pinachevo-central_nyj.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Авачинский — Центральный', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_2_avachinskij-central_nyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/2_avachinskij-central_nyj.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Пятая стройка — Центральный', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_2_5-ya_strojka-central_nyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/5-ya_strojka_-_central_nyj.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Центральный — Таловские источники — вулкан Дзендзур', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_3_central_nyj_-_talovskie_ist_-_dzendzur.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/3_talovskie-dzendzur.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Центральный — Таловские источники', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_3_central_nyj_-_talovskie_istochniki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/central_nyj_-_talovskie.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Центральный — Аагские нарзаны', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_5_central_nyj_-_aagskie_narzany.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/anyconv_com_tsentr-aagskie-shumninskie.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Центральный — Аагские нарзаны', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_4_central_nyj_-_aagskie_narzany.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/central_nyj_agskie.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Экструзия Верблюд', 'summer', 'июнь-октябрь', 'Для сохранения ландшафтов Перевала, проезд разрешен только до парковки рядом с базой «Камчатинтур»', ARRAY['https://www.vulcanikamchatki.ru/files/pasport_6_ekstruziya_verblyud.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/6_k_ekstruzii_verblyud.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Восхождение на Авачинский вулкан', 'summer', 'июнь-октябрь', 'Для сохранения ландшафтов Перевала, проезд разрешен только до парковки рядом с базой «Камчатинтур»', ARRAY['https://www.vulcanikamchatki.ru/files/pasport_7_voshozhdenie_na_avachinskij_vulkan.pdf','marshrut_voshozhdenie_na_avachinskij1.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/7_voshozhdenie_na_avachinskij_vulkan.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'На Авачинский перевал и экструзию Верблюд: зимний', 'winter', 'декабрь-май', 'На снегоходе, лыжах, снегоступах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_5_na_avachinskij_pereval_i_ekstruziyu_verblyud_zapret_kolesnoj_tehniki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/na_pereval_i_verblyud_-_tropa_i_ob_ekty.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Радыгино — Центральный', 'summer', 'июнь-октябрь', 'На автомобиле высокой проходимости', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_4_radygino_-_central_nyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/4_radygino_central_nyj.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Река Налычева — Река Островная: Транзитный', 'winter', 'декабрь-май', 'На снегоходе', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_6_reka_nalycheva_-_reka_ostrovnaya_tranzitnyj.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/kalagir_tranzit.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Река Налычева — Река Островная: Транзитный', 'summer', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_9_tranzitnyj_r_nalycheva_-_r_ostrovnaya.pdf','https://www.vulcanikamchatki.ru/files/2022/12/nalychevo_tranzit.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'Вокруг Вершинской', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_7_vokrug_vershinskoj.pdf','https://www.vulcanikamchatki.ru/files/2023/doc/po_sledam_beringii_1.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/vokrug_vershinskoj_11.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'На Авачинский перевал и экструзию Верблюд: зимний на колёсной технике', 'winter', 'декабрь-май', 'На колёсной технике', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/doc03666920250317174012.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/trek_avto_na_verblyuda.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'На Конические дайки Корякского вулкана', 'winter', 'декабрь-май', 'На снегоступах, на лыжах. Движение на технике запрещено!', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/pasport_8_na_konicheskie_dajki_koryakskogo_vulkana.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/8_k_konicheskim_dajkam.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('nalychevo', 'На Конические дайки Корякского вулкана', 'summer', 'июнь-октябрь', NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2025/pasport_2025/pasport_8_konicheskie_dajki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/8_k_konicheskim_dajkam.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Пионерская сопка', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/33_pasport_ppb_esso_-_pionerskaya_sopka.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Пионерская сопка', 'summer', 'июнь-сентябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/1_pasport_ppb_esso_-_pionerskaya_sopka.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/1_bp_pionerskaya_sopka.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Белые скалы', 'summer', 'июнь-октябрь', 'Передвижение пешком, на автомобиле (внедорожник)', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/2_pasport_ppb_esso_-_belye_skaly.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/2_bp_belye_skaly.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Белые скалы', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/34_pasport_ppb_esso_-_belye_skaly.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Тупикин ключ', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/3_pasport_ppb_esso-tupikin_klyuch.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/3_bp_tupikin_klyuch.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Тупикин ключ', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/35_pasport_ppb_esso-tupikin_klyuch.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Ручей Черемшанка', 'summer', 'июнь-октябрь', 'Пеший, конный маршрут', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/4_pasport_ppb_esso_-_cheremshanka.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/4_bp_cheremshanka.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Ручей Черемшанка', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/36_pasport_ppb_esso_-_cheremshanka.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Икар', 'summer', 'июнь-октябрь', 'Передвижение пешком, на лошади, на квадроцикле, на автомобиле (внедорожник)', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/5_pasport_ppb_esso_-_ikar.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/5_bp_ikar.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Икар', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/37_pasport_ppb_esso_-_ikar.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Черный замок', 'summer', 'июнь-октябрь', 'Передвижение пешком, на лошади, на квадроцикле, частично на внедорожнике. От беседки «Черный замок» 2 км пешком по тропе до вершины скалы.', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/6_pasport_ppb_esso_-_chyornyj_zamok.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/6_bp_chyornyj_zamok.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Черный замок', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/38_pasport_ppb_esso_-_chyornyj_zamok.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Илмаган', 'summer', 'июнь-октябрь', 'Комбинированный способ передвижения (пешком и на автомобиле), на велосипеде', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/7_pasport_ppb_esso_-ilmagan.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/7_bp_ilmagan.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Илмаган', 'winter', NULL, NULL, ARRAY['https://www.vulcanikamchatki.ru/files/2023/doc/pasport/bystr/summer/38_pasport_ppb_esso_-ilmagan.pdf']::text[], NULL, 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Вулкашики', 'summer', 'июнь-октябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/8_pasport_ppb_esso-vulkashiki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/8_bp_vulkashiki.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Вулкашики', 'winter', 'декабрь-апрель', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/bystrinskiy/pasport_1_vulkashiki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2022/12/gps/8_bp_vulkashiki_gpx.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Синегорье', 'summer', 'июнь-сентябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/9_pasport_ppb_sinegor_e.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/9_bp_sinegor_e.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Вулкан Дыгерен-Олегенде', 'summer', 'июнь-сентябрь', 'Передвижение пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/10_pasport_ppb_esso_-_vulkan_dygeren-olengende.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/10_bp_dygeren-olengende.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Вулкан Дыгерен-Олегенде', 'winter', 'декабрь-апрель', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/bystrinskiy/pasport_2_vulkan_dygeren-olengende.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2022/12/gps/8_bp_vulkashiki_gpx.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Галямаки', 'summer', 'июнь-сентябрь', 'Пеший, конный маршрут', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/11_pasport_ppb_esso_-_galyamaki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/11_bp_galyamaki_leto.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Озеро Галямаки', 'winter', 'декабрь-апрель', 'На снегоходе', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/bystrinskiy/pasport_3_galyamaki.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2022/12/gps/galyamaki_zim_cherez_krasnuyu_sop_1.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Димшиканский кордон', 'summer', 'июнь-октябрь', 'Передвижение пешком, на лошади, на квадроцикле, на автомобиле (внедорожник)', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/12_pasport_ppb_esso_-_dimshikanskij_kordon.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/12_bp_dimshikanskij.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Димшиканский кордон', 'winter', 'декабрь-апрель', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/bystrinskiy/pasport_4_dimshikanskij_kordon.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2022/12/gps/12_bp_dimshikanskij_gpx.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Ичинский вулкан', 'summer', 'июнь-сентябрь', 'Передвижение пешком, на лошади, на квадроцикле', ARRAY['http://vulcanikamchatki.ru/files/2022/06/7/pasport_13_ichinskij_vulkan.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/14_bp_ichinskij_k_dal_nij.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Каньон сноубордистов', 'summer', 'июнь-октябрь', 'Пеший, конный маршрут', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/13_pasport_ppb_esso_-_kan_on_snoubordistov.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/13_bp_kan_on_snoubordistov.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('bystrinskiy', 'Каньон сноубордистов', 'winter', 'декабрь-апрель', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/bystrinskiy/pasport_5_kan_on_snoubordistov.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/kan_on_snoubordistov_1.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'Восхождение на вулкан Вилючинский', 'all', 'всесезонный', 'На лыжах, пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_2_voshozhdenie_na_vilyuchinskij_vulkan.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/2_trek_voshozhdenie_vilyuchinskij.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'Вилючинский водопад', 'summer', 'июнь-октябрь', 'Пешком', ARRAY['https://www.vulcanikamchatki.ru/files/2025/pasport_2025/ilovepdf_merged.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2024/gpx/1_trek_vilyuchinskij_vodopad.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'Вилючинский водопад', 'winter', 'декабрь-май', 'На лыжах, пешком, на снегоходе', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/viliuchinskiy/pasport_2_vilyuchinskij_vodopad.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/vilyuchinskij_vodopad.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'К озеру Тополовому', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/viliuchinskiy/pasport_4_k_ozeru_topolovomu.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/snegohodnyj_ozero_topolovoe.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'К озеру Зелёному', 'winter', 'декабрь-май', 'На снегоходе, на лыжах', ARRAY['https://www.vulcanikamchatki.ru/images/2024/pasporta_zima_2025/viliuchinskiy/pasport_1_k_ozeru_zelenomu.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/snegohodnyj_ozero_zelenoe.7z', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/'),
  ('vilyuchinsky', 'К озеру Зелёному', 'summer', 'июнь-октябрь', 'Пешком', ARRAY['https://www.vulcanikamchatki.ru/files/pasporta_2024/pasport_3_k_ozeru_zelenomu_letnij.pdf']::text[], 'https://www.vulcanikamchatki.ru/files/2025/gpx/3_trek_ozero_zelenoe.zip', 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/')
) AS v(park_slug, title, season, period, movement, passport_urls, track_url, source_url)
 WHERE EXISTS (SELECT 1 FROM parks p WHERE p.slug = v.park_slug)
ON CONFLICT (park_slug, title, season) DO NOTHING;

INSERT INTO park_approved_route_links (approved_route_id, route_id, checked_note)
SELECT a.id, r.id, v.note
  FROM (VALUES
  ('nalychevo', 'Пиначево — Центральный', 'visitkamchatka-pinachevo-centre', 'то же название; линейный 39 км, территория «Природный парк Налычево»'),
  ('nalychevo', 'Пиначево — Центральный', 'marshrut-pinachevo-tsentralnyy-25f624cb', 'то же название; описание «от Пиначево к Центральному кордону» Налычево'),
  ('nalychevo', 'Авачинский — Центральный', 'visitkamchatka-avachin-centre', 'то же название; линейный 37 км, 2 дня, территория «Налычево»'),
  ('nalychevo', 'Пятая стройка — Центральный', 'visitkamchatka-5-stroyka', 'то же название («5 стройка–Центральный»); перевал Корякский на пути'),
  ('nalychevo', 'Центральный — Таловские источники — вулкан Дзендзур', 'visitkamchatka-talov-ist', 'то же название; Жупановский на маршруте'),
  ('nalychevo', 'Центральный — Таловские источники', 'visitkamchatka-talovsk-centre', 'то же название; радиальный 12 км, Жупановский на маршруте'),
  ('nalychevo', 'Центральный — Аагские нарзаны', 'visitkamchatka-aagskiye', 'то же название («Центральный: Аагские нарзаны»); радиальный 12 км'),
  ('nalychevo', 'Экструзия Верблюд', 'ekstruziya-verblyud-2', 'то же название; 2,7 км, +308 м от Авачинского перевала'),
  ('nalychevo', 'Восхождение на Авачинский вулкан', 'voshozhdenie-na-avachinskij-vulkan', 'то же название; радиальный 14 км, +1859 м, территория «Налычево»'),
  ('nalychevo', 'Восхождение на Авачинский вулкан', 'nochnoe-voshozhdenie-na-avachinskij-vulkan-marshrut', 'ночной вариант того же подъёма; +1859 м'),
  ('nalychevo', 'На Авачинский перевал и экструзию Верблюд: зимний', 'na-avachinskij-pereval-i-ekstruziyu-verblyud-marshrut', 'то же название без слова «зимний»; 8,6 км'),
  ('nalychevo', 'Радыгино — Центральный', 'visitkamchatka-radyg-centre', 'то же название («Радыгино–Центральный»)'),
  ('nalychevo', 'Река Налычева — Река Островная: Транзитный', 'visitkamchatka-nalychevo-tranzit', 'то же название; территория «Налычево»'),
  ('bystrinskiy', 'Пионерская сопка', 'sopka-pionerskaya', 'то же название; радиальный 4 км, +370 м, высота 870 м — сопка над Эссо'),
  ('bystrinskiy', 'Белые скалы', 'belye-skaly-marshrut', 'то же название; 5,4 км, место «Белые скалы» у Эссо'),
  ('bystrinskiy', 'Тупикин ключ', 'visitkamchatka-tupikin', 'то же название; кольцевой, территория «Быстринский»'),
  ('bystrinskiy', 'Тупикин ключ', 'eko-tropa-tupikin-klyuch-2', '«Эко-тропа Тупикин ключ», 2,6 км'),
  ('bystrinskiy', 'Ручей Черемшанка', 'visitkamchatka-cheremshanka', 'то же название; радиальный 6,5 км'),
  ('bystrinskiy', 'Ручей Черемшанка', 'eko-tropa-cheremshanka', '«Эко-тропа Черемшанка», 6,2 км'),
  ('bystrinskiy', 'Озеро Икар', 'ozero-ikar-2', 'то же название; 7,7 км, место «Озеро Икар» у Эссо'),
  ('bystrinskiy', 'Черный замок', 'visitkamchatka-chernyi-zamok', 'то же название («Чёрный замок»); радиальный'),
  ('bystrinskiy', 'Черный замок', 'skala-chernyj-zamok-marshrut', '«Скала Черный замок», 11,7 км; место у Эссо'),
  ('bystrinskiy', 'Озеро Илмаган', 'ozero-ilmagan-marshrut', 'то же название; 18,7 км, место к северу от Эссо'),
  ('bystrinskiy', 'Вулкашики', 'vulkashiki', 'то же название; 24,9 км'),
  ('bystrinskiy', 'Вулкан Дыгерен-Олегенде', 'visitkamchatka-volcano-dygeren', 'то же название («Дыгерен-Оленгендэ»)'),
  ('bystrinskiy', 'Вулкан Дыгерен-Олегенде', 'gora-dygeren-olengende-marshrut', '«Гора Дыгерен-Оленгенде», 21,7 км; место у Эссо'),
  ('bystrinskiy', 'Озеро Галямаки', 'ozero-galyamaki-marshrut', 'то же название; 33 км, место к югу от Эссо'),
  ('bystrinskiy', 'Димшиканский кордон', 'dimshikanskij-kordon-marshrut', 'то же название; радиальный 10 км, территория «Вулканы Камчатки»'),
  ('bystrinskiy', 'Ичинский вулкан', 'vulkan-ichinskaya-sopka', 'Ичинский вулкан на маршруте; старт в записи не указан'),
  ('bystrinskiy', 'Каньон сноубордистов', 'kanon-snoubordistov-marshrut', 'то же название; радиальный 10 км, зимний'),
  ('vilyuchinsky', 'Восхождение на вулкан Вилючинский', 'visitkamchatka-viluch-volcano', 'то же название; радиальный 6 км, территория «Вилючинский»'),
  ('vilyuchinsky', 'Восхождение на вулкан Вилючинский', 'vulkan-vilyuchinskij-marshrut', '«Вулкан Вилючинский», +1915 м, территория «Вилючинский»'),
  ('vilyuchinsky', 'Вилючинский водопад', 'vilyuchinskij-vodopad', 'то же название; 1,9 км, территория «Вилючинский»'),
  ('vilyuchinsky', 'К озеру Тополовому', 'visitkamchatka-lake-topolov-winter', 'то же название; радиальный 14 км, зимний'),
  ('vilyuchinsky', 'К озеру Тополовому', 'ozero-topolovoe-marshrut', '«Озеро Тополовое», 12,6 км, территория «Вилючинский»'),
  ('vilyuchinsky', 'К озеру Зелёному', 'ozero-zelenoe-marshrut', '«Озеро Зелёное», 6,2 км, территория «Вилючинский»'),
  ('vilyuchinsky', 'К озеру Зелёному', 'visitkamchatka-green-lake-winter', '«К озеру Зеленому», радиальный 8 км, зимний')
) AS v(park_slug, title, route_slug, note)
  JOIN park_approved_routes a ON a.park_slug = v.park_slug AND a.title = v.title
  JOIN kamchatka_routes r ON r.slug = v.route_slug
ON CONFLICT (approved_route_id, route_id) DO NOTHING;

