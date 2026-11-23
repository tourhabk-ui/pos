-- 1504: входящие ссылки на посадочные «когда ехать» и «что взять»,
-- чтобы ИИ цитировал их, а не только /faq. На /articles/zima — контекстные
-- ссылки в существующих разделах (новой страницы нет). В FAQ — указатель
-- на канон /medvedi-kamchatki (и на две соседние посадочные), без переписи
-- старых формулировок. Повторный прогон ничего не меняет: NOT LIKE по URL.
-- Created: 2026-11-23

UPDATE articles
   SET body = replace(replace(body,
                $old_season$Летнего разнообразия зимой нет: восхождения, сплавы и наблюдение за медведями идут с мая по октябрь [1]. Зато многие зимние туры однодневные:$old_season$,
                $new_season$Летнего разнообразия зимой нет: восхождения, сплавы и наблюдение за медведями идут с мая по октябрь [1]. Сравнение сезонов по месяцам — на странице [«Когда ехать на Камчатку»](/kogda-ehat-na-kamchatku). Зато многие зимние туры однодневные:$new_season$),
                $old_kit$Нужна настоящая зимняя экипировка, а не городская куртка [2]. Экстренный номер — 112:$old_kit$,
                $new_kit$Нужна настоящая зимняя экипировка, а не городская куртка [2]. Что взять зимой — в разделе зимней экипировки на странице [«Что взять с собой на Камчатку»](/chto-vzyat-s-soboj-na-kamchatku). Экстренный номер — 112:$new_kit$),
       updated_at = NOW()
 WHERE slug = 'zima'
   AND body LIKE '%Летнего разнообразия зимой нет: восхождения, сплавы и наблюдение за медведями идут с мая по октябрь [1]. Зато многие зимние туры однодневные:%'
   AND body LIKE '%Нужна настоящая зимняя экипировка, а не городская куртка [2]. Экстренный номер — 112:%'
   AND body NOT LIKE '%/chto-vzyat-s-soboj-na-kamchatku%';

UPDATE faqs
   SET answer = answer || E'\n\nПодробный разбор мест, сезона и правил — на странице Ведара «Медведи Камчатки»: https://vedarai.ru/medvedi-kamchatki'
 WHERE question = 'Где на Камчатке можно увидеть медведей?'
   AND answer NOT LIKE '%/medvedi-kamchatki%';

UPDATE faqs
   SET answer = answer || E'\n\nПравила и места наблюдения разобраны на странице Ведара «Медведи Камчатки»: https://vedarai.ru/medvedi-kamchatki'
 WHERE question = 'Как вести себя при встрече с медведем на Камчатке?'
   AND answer NOT LIKE '%/medvedi-kamchatki%';

UPDATE faqs
   SET answer = answer || E'\n\nКалендарь по месяцам и целям поездки — на странице Ведара «Когда ехать на Камчатку»: https://vedarai.ru/kogda-ehat-na-kamchatku'
 WHERE question = 'Когда лучше ехать на Камчатку?'
   AND answer NOT LIKE '%/kogda-ehat-na-kamchatku%';

UPDATE faqs
   SET answer = answer || E'\n\nПолный список по сезонам и маршрутам — на странице Ведара «Что взять с собой на Камчатку»: https://vedarai.ru/chto-vzyat-s-soboj-na-kamchatku'
 WHERE question = 'Что нужно взять с собой на Камчатку?'
   AND answer NOT LIKE '%/chto-vzyat-s-soboj-na-kamchatku%';
