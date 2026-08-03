-- Migration 807: в витрине — ТОЛЬКО туры двух реальных партнёров
--
-- Решение владельца (03.08): у платформы пока ДВА партнёра, и мы показываем
-- только те туры, что они предоставили:
--   • «Камчатка Рафтинг» (slug kamchatka-rafting) — сплав по Быстрой;
--   • «Камчатская Рыбалка» (fishingkam / kamchatskaya-rybalka /
--     rybalka-po-kamchatski, либо name ~ «камчатская рыбалка»).
--
-- Что чиним: на проде в каталоге всплыли чужие/демо-туры —
--   • демо-оператор «Рога и Копыта» (тур-заглушка, не наш партнёр);
--   • миграция 801 опубликовала ВСЁ по слову «рыбалк» без привязки к партнёру,
--     т.е. могла вывести демо-туры не от «Камчатской Рыбалки».
--
-- Прячем (is_published=FALSE, is_active=FALSE) любой тур, оператор которого НЕ
-- один из двух реальных партнёров — включая туры без оператора и с оператором-
-- сиротой. Это ОБРАТИМО (не удаляем, deleted_at не трогаем): вернуть тур в
-- витрину — снова выставить флаги. Идемпотентна: повторный прогон ничего нового
-- не трогает (условие «сейчас видимый» перестаёт выполняться).
--
-- Туры двух партнёров НЕ трогаем — они остаются как есть.

UPDATE operator_tours ot
   SET is_published = FALSE,
       is_active    = FALSE,
       updated_at   = NOW()
 WHERE ot.deleted_at IS NULL
   AND (ot.is_published = TRUE OR ot.is_active = TRUE)
   AND NOT EXISTS (
     SELECT 1
       FROM partners p
      WHERE p.id = ot.operator_id
        AND (
             p.slug = 'kamchatka-rafting'
          OR p.slug IN ('fishingkam', 'kamchatskaya-rybalka', 'rybalka-po-kamchatski')
          OR p.name ILIKE '%камчатская рыбалка%'
          OR p.name ILIKE '%рыбалка по-камчатски%'
        )
   );
