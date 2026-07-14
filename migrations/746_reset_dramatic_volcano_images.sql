-- 746_reset_dramatic_volcano_images.sql
--
-- Старый volcano-промпт AI-генератора (lib/services/ai-image-generator.ts)
-- требовал ИЗВЕРЖЕНИЕ: "volcanic eruption with lava glow and ash column,
-- pyroclastic flows". Поэтому ВСЕ вулканы каталога (в т.ч. давно потухшие —
-- Авача, Мишенная) получали кадр фейкового извержения / чёрного пепла с
-- жёлтыми лужами. Промпт заменён на спокойный заснеженный конус.
--
-- Удаляем изображения, сгенерированные старым промптом — они перегенерятся с
-- новым при первом показе карточки (GET /api/images/route/[id] генерит на лету,
-- если строки нет). Идемпотентно: повторный прогон просто ничего не найдёт.

DELETE FROM ai_route_images
WHERE prompt ILIKE '%eruption%'
   OR prompt ILIKE '%pyroclastic%';
