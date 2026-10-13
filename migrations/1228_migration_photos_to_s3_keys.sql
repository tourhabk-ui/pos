-- 1228: снимки из миграций на проде — ключ хранилища вместо байтов, по хэшу байтов.
--
-- Решение владельца 13.10: «согласен, перенеси в S3». 59 миграций (930–1211)
-- клали 154 JPEG байтами; на проде они лежат в image_data героя
-- (ai_route_images) и галереи (place_gallery_photos). Объекты залиты в хранилище
-- с раннера по маркеру .github/triggers/migration-photos-to-s3.json и прочитаны
-- обратно (sha256 сошёлся) — ДО этой миграции, как у клипов туров (1194).
--
-- Строка опознаётся ПО ХЭШУ СВОИХ БАЙТОВ, а не по месту и позиции: как миграция
-- привязывала снимок к месту (uuid, OR ark_id, IN (…), по имени, max(position)+1),
-- здесь неважно — sha256(image_data) равен sha256 залитого объекта ровно у той
-- строки, чьи байты лежат в хранилище. Чужой снимок (другой хэш) не тронется.
-- Хэш считается один раз на строку: ключи — во временной таблице, один UPDATE
-- на таблицу (150 отдельных UPDATE хэшировали бы каждую строку 150 раз и не
-- уложились бы в 60 с наката при старте контейнера, start.js).
--
-- Третий исход — вслух: сколько строк переведено, сколько ещё несут байты
-- (например, строки, перезаписанные позже другой миграцией с другими байтами).
-- s3_url не трогается: у строк с байтами он NULL (уборщик обнуляет байты, когда
-- ставит адрес), а раздача (13.10) читает s3_url, потом s3_key, потом байты.
--
-- Повтор безопасен: строки без байтов условие не проходят.
--
-- IDEMPOTENT

CREATE TEMP TABLE _migration_photo_keys (sha256 TEXT PRIMARY KEY, s3_key TEXT NOT NULL);

INSERT INTO _migration_photo_keys (sha256, s3_key) VALUES
  ('35abcb1cd064cd7dfa14a14e2e43275919da06d9310753f4455a974f2a0630b0', 'migrations/photos/35abcb1cd064cd7dfa14a14e2e43275919da06d9310753f4455a974f2a0630b0.jpg'),
  ('6b4c7452bce2806b480474c175439d67649c6e24237a615f5b253fda78e1c799', 'migrations/photos/6b4c7452bce2806b480474c175439d67649c6e24237a615f5b253fda78e1c799.jpg'),
  ('28cc9f6881533d31fc28f1bc4b8c2d87852c83e40db8361de1f76bb1435cbf36', 'migrations/photos/28cc9f6881533d31fc28f1bc4b8c2d87852c83e40db8361de1f76bb1435cbf36.jpg'),
  ('f517dc0ad0daca916fe7a67006a92a53b4f52c7981b379db8af2903ab216484c', 'migrations/photos/f517dc0ad0daca916fe7a67006a92a53b4f52c7981b379db8af2903ab216484c.jpg'),
  ('9c573d9cf5b6bc2aadda98e24c1a65e5ac4502c6e60e0706a57d346cb02761c1', 'migrations/photos/9c573d9cf5b6bc2aadda98e24c1a65e5ac4502c6e60e0706a57d346cb02761c1.jpg'),
  ('0f47b90912a5d7990ad4ff58f2a46f08a825e22a3a74f0e37f41c7e75bef8a0e', 'migrations/photos/0f47b90912a5d7990ad4ff58f2a46f08a825e22a3a74f0e37f41c7e75bef8a0e.jpg'),
  ('3aa833ce843057ea975e2b3bd4ac41b58c3e8aa15575fdd8c15f132655ab3027', 'migrations/photos/3aa833ce843057ea975e2b3bd4ac41b58c3e8aa15575fdd8c15f132655ab3027.jpg'),
  ('ed47c24ce0b787e363c9162f3857848bcab6a50069610724b9ee3015d63119d9', 'migrations/photos/ed47c24ce0b787e363c9162f3857848bcab6a50069610724b9ee3015d63119d9.jpg'),
  ('8ad867b2d90ea76dfebf6bceae80c5be4702a6131f50c1e809fe1f8661801f36', 'migrations/photos/8ad867b2d90ea76dfebf6bceae80c5be4702a6131f50c1e809fe1f8661801f36.jpg'),
  ('ea4ac97f140b46e3af8b87b6e518394eb24e1d089a57dddeba0fd8d1f37139f4', 'migrations/photos/ea4ac97f140b46e3af8b87b6e518394eb24e1d089a57dddeba0fd8d1f37139f4.jpg'),
  ('930be7f249affa0fb02ce26ba2567449655ff61932fd462c5fafb629488c9fad', 'migrations/photos/930be7f249affa0fb02ce26ba2567449655ff61932fd462c5fafb629488c9fad.jpg'),
  ('f2c008d45cb331f5236be1944992e571f63f8e821616d0f63951605f1178488c', 'migrations/photos/f2c008d45cb331f5236be1944992e571f63f8e821616d0f63951605f1178488c.jpg'),
  ('7d7ffec42b993e5958aba62e6f96d157c2c912058cb61a548d7122ecd13adab5', 'migrations/photos/7d7ffec42b993e5958aba62e6f96d157c2c912058cb61a548d7122ecd13adab5.jpg'),
  ('b8192a6a93b8f7c4c88d7b0251340456ea93f72f562b33966d05f0aa0ba5b04b', 'migrations/photos/b8192a6a93b8f7c4c88d7b0251340456ea93f72f562b33966d05f0aa0ba5b04b.jpg'),
  ('30494ef171e05e79c40796bb6e3ba15457ee34fffcba7723da247571aba69a06', 'migrations/photos/30494ef171e05e79c40796bb6e3ba15457ee34fffcba7723da247571aba69a06.jpg'),
  ('ceab1971753d0773bb0faf53f64df505ad287a079befd41be82cd307ce1e959d', 'migrations/photos/ceab1971753d0773bb0faf53f64df505ad287a079befd41be82cd307ce1e959d.jpg'),
  ('fb9a17aafbd6d840a9f7d633c0170d9bdd7242450afcaa07fa70c04bb89b1430', 'migrations/photos/fb9a17aafbd6d840a9f7d633c0170d9bdd7242450afcaa07fa70c04bb89b1430.jpg'),
  ('2a3ed3fe611c1f0be0a0bc878f12b956b0798bf2c52569981149aa1ea0cdf26b', 'migrations/photos/2a3ed3fe611c1f0be0a0bc878f12b956b0798bf2c52569981149aa1ea0cdf26b.jpg'),
  ('00e1e11d3b5ecfba8261a4ffe85f11264d75c03f4d8473e8846c9f1e686456c3', 'migrations/photos/00e1e11d3b5ecfba8261a4ffe85f11264d75c03f4d8473e8846c9f1e686456c3.jpg'),
  ('d881eafe736334371c4b23ec602576f87d3db7fbad990d50ef309e984bc7b220', 'migrations/photos/d881eafe736334371c4b23ec602576f87d3db7fbad990d50ef309e984bc7b220.jpg'),
  ('b621b82fe302e26e79393d3c24e8daa404a29bdf804811a4702f6b7c424919d9', 'migrations/photos/b621b82fe302e26e79393d3c24e8daa404a29bdf804811a4702f6b7c424919d9.jpg'),
  ('bfe4fa9729a4586360566016941575bb66d1db3eae192448fd738a7c12c1456a', 'migrations/photos/bfe4fa9729a4586360566016941575bb66d1db3eae192448fd738a7c12c1456a.jpg'),
  ('828a5c72933dc7302f1d5275aab5d0a4f28c6ce18b8b63a239d98712a8c98de6', 'migrations/photos/828a5c72933dc7302f1d5275aab5d0a4f28c6ce18b8b63a239d98712a8c98de6.jpg'),
  ('da00eff47a5103014d62c08e7fc579c0b0c5872cffb6fb3334181655cc31ae4a', 'migrations/photos/da00eff47a5103014d62c08e7fc579c0b0c5872cffb6fb3334181655cc31ae4a.jpg'),
  ('2a4c6d21995eb80ea8d90cfbb33088e3de1ca2cf99f376f28f2b91e1e5871e73', 'migrations/photos/2a4c6d21995eb80ea8d90cfbb33088e3de1ca2cf99f376f28f2b91e1e5871e73.jpg'),
  ('973283447660868f138a13b006d81dc109c2f02456e5607fb189646389886837', 'migrations/photos/973283447660868f138a13b006d81dc109c2f02456e5607fb189646389886837.jpg'),
  ('0fa01233a677c2b79ffed3242079499343d31039e52586667d0301aede45f817', 'migrations/photos/0fa01233a677c2b79ffed3242079499343d31039e52586667d0301aede45f817.jpg'),
  ('a9ffb5a0cea9f046d3be61fdd57258adcb1cf473eb3623267bb70eb735f5c385', 'migrations/photos/a9ffb5a0cea9f046d3be61fdd57258adcb1cf473eb3623267bb70eb735f5c385.jpg'),
  ('533aecd121df375a1a31eac25565ef332c37314a3007711f1132cc15729cd2d0', 'migrations/photos/533aecd121df375a1a31eac25565ef332c37314a3007711f1132cc15729cd2d0.jpg'),
  ('69aca2cf6e090f4a4e902b85ca87f4468f6f63f1eef2e34dee7798271da4da63', 'migrations/photos/69aca2cf6e090f4a4e902b85ca87f4468f6f63f1eef2e34dee7798271da4da63.jpg'),
  ('5df09e1b4e0f1ad4578e7cedcc9f636156e08d12b53fefca6207dd65691e1acb', 'migrations/photos/5df09e1b4e0f1ad4578e7cedcc9f636156e08d12b53fefca6207dd65691e1acb.jpg'),
  ('c9fa32780ef7542f1d5338e659aef2426a67835311957d36cacacd3e93163ca0', 'migrations/photos/c9fa32780ef7542f1d5338e659aef2426a67835311957d36cacacd3e93163ca0.jpg'),
  ('a8b73722e61a146622f015f4e18f74682a7d20c9fd1ad50a577542046aa93839', 'migrations/photos/a8b73722e61a146622f015f4e18f74682a7d20c9fd1ad50a577542046aa93839.jpg'),
  ('261b1dfc1dec9a186a59b690a707fb6df5986dace3f0843578e38b80276c59bc', 'migrations/photos/261b1dfc1dec9a186a59b690a707fb6df5986dace3f0843578e38b80276c59bc.jpg'),
  ('e517d250d4aacf85a4796e76b31bd42565fce81c0bdaff4a48f1fa6465e4cf50', 'migrations/photos/e517d250d4aacf85a4796e76b31bd42565fce81c0bdaff4a48f1fa6465e4cf50.jpg'),
  ('77240a9563f9a9b5d99bf5be5a05626109de83c6c42ac96327144aeba40ac813', 'migrations/photos/77240a9563f9a9b5d99bf5be5a05626109de83c6c42ac96327144aeba40ac813.jpg'),
  ('7822bc643babadcf3853c92d1ca7068558e6bccee278edd6404a7112b1101ee4', 'migrations/photos/7822bc643babadcf3853c92d1ca7068558e6bccee278edd6404a7112b1101ee4.jpg'),
  ('984d48b30b47fec4846194fbd56b77e11757f8d2a131fd94a6dc55ab76fe2858', 'migrations/photos/984d48b30b47fec4846194fbd56b77e11757f8d2a131fd94a6dc55ab76fe2858.jpg'),
  ('69c946777a7ec42d8104bb026c300b687d66c0d65628bff0d52c05fc4c1893be', 'migrations/photos/69c946777a7ec42d8104bb026c300b687d66c0d65628bff0d52c05fc4c1893be.jpg'),
  ('657da9873eb410c8d5c947920efd6fd8ef64685ab4182bdb865f1fbe51e857b2', 'migrations/photos/657da9873eb410c8d5c947920efd6fd8ef64685ab4182bdb865f1fbe51e857b2.jpg'),
  ('ad58bbb3e9e2cd062d925da331696cab80ca85ff0d08b30c7585c4ecd49c4ce9', 'migrations/photos/ad58bbb3e9e2cd062d925da331696cab80ca85ff0d08b30c7585c4ecd49c4ce9.jpg'),
  ('25e73f92e3702f09c72963215be92dd63d3d4d0ada00745c045c15aced658cab', 'migrations/photos/25e73f92e3702f09c72963215be92dd63d3d4d0ada00745c045c15aced658cab.jpg'),
  ('f235e073cfb248ed778fc9d732e95fdb3ed5ebade2459d371a77286bde1eee0b', 'migrations/photos/f235e073cfb248ed778fc9d732e95fdb3ed5ebade2459d371a77286bde1eee0b.jpg'),
  ('db9ddea1dd8ec2e9a654078987b4ccfd32eb1a78f2c9c58e775ecfbb8fe6c9c9', 'migrations/photos/db9ddea1dd8ec2e9a654078987b4ccfd32eb1a78f2c9c58e775ecfbb8fe6c9c9.jpg'),
  ('a8b9f3741823e833661dfd936c8fab62c2e79a2d57587af42114e68457f92b85', 'migrations/photos/a8b9f3741823e833661dfd936c8fab62c2e79a2d57587af42114e68457f92b85.jpg'),
  ('f16195016b815c0119155ca02cf078368d06c33dbd018811c9a91d8783f02dd2', 'migrations/photos/f16195016b815c0119155ca02cf078368d06c33dbd018811c9a91d8783f02dd2.jpg'),
  ('e8e7def7f599fac3cb2a5c1b4a775424425baa3782d400595b24214c088ebdb8', 'migrations/photos/e8e7def7f599fac3cb2a5c1b4a775424425baa3782d400595b24214c088ebdb8.jpg'),
  ('e2c7051b6d2293797c9f4bee72477346e922a6db6784aeb05e026d00b0254bf8', 'migrations/photos/e2c7051b6d2293797c9f4bee72477346e922a6db6784aeb05e026d00b0254bf8.jpg'),
  ('baa03f5e356f38a30c00818154562923798a2321ac39cb58f0260f82e37b0a6c', 'migrations/photos/baa03f5e356f38a30c00818154562923798a2321ac39cb58f0260f82e37b0a6c.jpg'),
  ('0148e729faaffe23aab50b19045195f4593f4640f9e0c91d6b23e1be5205c6f4', 'migrations/photos/0148e729faaffe23aab50b19045195f4593f4640f9e0c91d6b23e1be5205c6f4.jpg'),
  ('31b11db6aa362bc809f6cc2115a6bcca761b51e4a927986bb51fc4bd357c9eec', 'migrations/photos/31b11db6aa362bc809f6cc2115a6bcca761b51e4a927986bb51fc4bd357c9eec.jpg'),
  ('eca1047b9680b1a2a580daec73470396051e7056bbbe8fc8139ca4721bc4c48a', 'migrations/photos/eca1047b9680b1a2a580daec73470396051e7056bbbe8fc8139ca4721bc4c48a.jpg'),
  ('6f00f8643f72eeda1bd562d45ed7510eca53120442fb40730d10869d8b19f30e', 'migrations/photos/6f00f8643f72eeda1bd562d45ed7510eca53120442fb40730d10869d8b19f30e.jpg'),
  ('03a5dec01ee8990a3a7e3199b560634325b81762e54e188dcbfdb27701980484', 'migrations/photos/03a5dec01ee8990a3a7e3199b560634325b81762e54e188dcbfdb27701980484.jpg'),
  ('ca6833a858a6a7d12fa3e6649208b3bd499c49410f21d54fbb6074b685992e45', 'migrations/photos/ca6833a858a6a7d12fa3e6649208b3bd499c49410f21d54fbb6074b685992e45.jpg'),
  ('0881a996c9a04254a9508528e8e4245abf8996b1de38f7471d11e58e9a69ca21', 'migrations/photos/0881a996c9a04254a9508528e8e4245abf8996b1de38f7471d11e58e9a69ca21.jpg'),
  ('da81ff7670789c7a2e64fe5f05e5326322d293e570813bb7afefa71088059f60', 'migrations/photos/da81ff7670789c7a2e64fe5f05e5326322d293e570813bb7afefa71088059f60.jpg'),
  ('961286aa3242f6520284b851e88845f0e958b507d18e5a262ff4d5ac0fcfd60f', 'migrations/photos/961286aa3242f6520284b851e88845f0e958b507d18e5a262ff4d5ac0fcfd60f.jpg'),
  ('f399943c6d623cb2979ec96b6d65ca1236e965a0c40c3043cf079f545199fdb8', 'migrations/photos/f399943c6d623cb2979ec96b6d65ca1236e965a0c40c3043cf079f545199fdb8.jpg'),
  ('6bbf443b3c37eb6bc3384abcaa956fbc7f88c85ab404b34ea3248e9a1547bbea', 'migrations/photos/6bbf443b3c37eb6bc3384abcaa956fbc7f88c85ab404b34ea3248e9a1547bbea.jpg'),
  ('ca3900c317bfc6ed45b199ec16372e6aa81d759e78cac8cfe278cd5f9530d512', 'migrations/photos/ca3900c317bfc6ed45b199ec16372e6aa81d759e78cac8cfe278cd5f9530d512.jpg'),
  ('0f81e4318dd6cbf310bbcb1e6defbeeed0e2d6dc65dd1ed401f8663bcaf01d2f', 'migrations/photos/0f81e4318dd6cbf310bbcb1e6defbeeed0e2d6dc65dd1ed401f8663bcaf01d2f.jpg'),
  ('ce682d911b587d052881445dcd015c6fc669e96ec69d33a63b2058d36c22a2a0', 'migrations/photos/ce682d911b587d052881445dcd015c6fc669e96ec69d33a63b2058d36c22a2a0.jpg'),
  ('2ba9bb9a786f2be5c10b880501a289df3959584fc6416a6061e363761c19caa0', 'migrations/photos/2ba9bb9a786f2be5c10b880501a289df3959584fc6416a6061e363761c19caa0.jpg'),
  ('f5af7b6dfa4261f852d71aa9dd4b686781aaf9432b0a8d151a4c23963fde9f5e', 'migrations/photos/f5af7b6dfa4261f852d71aa9dd4b686781aaf9432b0a8d151a4c23963fde9f5e.jpg'),
  ('da8c5524f9a594e97584acc8fb51556044e1fa0eb23b1a572ff8fd025d736f9d', 'migrations/photos/da8c5524f9a594e97584acc8fb51556044e1fa0eb23b1a572ff8fd025d736f9d.jpg'),
  ('cbaca84dd74b12f5e8c12ed22c232ea1923d87cfe01125cc9d03a0aae75d0611', 'migrations/photos/cbaca84dd74b12f5e8c12ed22c232ea1923d87cfe01125cc9d03a0aae75d0611.jpg'),
  ('a51e7af336fb7f0b63da46170e33355fb4c2656f8ccdb784bb720876d9ac186f', 'migrations/photos/a51e7af336fb7f0b63da46170e33355fb4c2656f8ccdb784bb720876d9ac186f.jpg'),
  ('f58eef85aecf5f053fb71491e722f20e5eef055a8522167abc3031e3fd7d9706', 'migrations/photos/f58eef85aecf5f053fb71491e722f20e5eef055a8522167abc3031e3fd7d9706.jpg'),
  ('08958e37d8d8b5e59cab561b2e59484899a3056552ac60dd53ac7563818b54a3', 'migrations/photos/08958e37d8d8b5e59cab561b2e59484899a3056552ac60dd53ac7563818b54a3.jpg'),
  ('6438b8ee2755e6f9115ea1d235fa421e76abc119921c2abceeea5ac4c856ed3c', 'migrations/photos/6438b8ee2755e6f9115ea1d235fa421e76abc119921c2abceeea5ac4c856ed3c.jpg'),
  ('862d0e9001dd8f4e3838016d6b6afbf8837223982af42cc6daf51b8c21e0051a', 'migrations/photos/862d0e9001dd8f4e3838016d6b6afbf8837223982af42cc6daf51b8c21e0051a.jpg'),
  ('c608899d4e6bd3e6df760d478d55104181833b5b9a6a081ed751ccf0f8c2ec8c', 'migrations/photos/c608899d4e6bd3e6df760d478d55104181833b5b9a6a081ed751ccf0f8c2ec8c.jpg'),
  ('25d2a1e4b78b93b73393109807a48457e8c5a70947c6368b31c3ffb02c4c6c6e', 'migrations/photos/25d2a1e4b78b93b73393109807a48457e8c5a70947c6368b31c3ffb02c4c6c6e.jpg'),
  ('58e72afbfd6ddea7ad6139eb16d1213cd6d41c3b277a1ca2c2ca83b57f50fdd2', 'migrations/photos/58e72afbfd6ddea7ad6139eb16d1213cd6d41c3b277a1ca2c2ca83b57f50fdd2.jpg'),
  ('8b71983bd61d2e81ac5561633c2afad0199b351c4d97348e5dbef8b3b7e70453', 'migrations/photos/8b71983bd61d2e81ac5561633c2afad0199b351c4d97348e5dbef8b3b7e70453.jpg'),
  ('1a02e797f978da8d4c114aee09fc25b5dba857de848a94a58e63cdd97743595b', 'migrations/photos/1a02e797f978da8d4c114aee09fc25b5dba857de848a94a58e63cdd97743595b.jpg'),
  ('9c257927729b9058691b75d0cd191188f7616fc6355bb87e2310621ed2f1312b', 'migrations/photos/9c257927729b9058691b75d0cd191188f7616fc6355bb87e2310621ed2f1312b.jpg'),
  ('1904df006534bae8115bfccce1eaaafec315bdf98bcd2a643af83276b7850b42', 'migrations/photos/1904df006534bae8115bfccce1eaaafec315bdf98bcd2a643af83276b7850b42.jpg'),
  ('2b65b4418a05fc15a846061aa50adfa053a44d6a521ee79fa73b18ed84872740', 'migrations/photos/2b65b4418a05fc15a846061aa50adfa053a44d6a521ee79fa73b18ed84872740.jpg'),
  ('79f48280dd16a81ff3affc3cf936a2abdec667b236e62c0d0af0bec6ef68e2bb', 'migrations/photos/79f48280dd16a81ff3affc3cf936a2abdec667b236e62c0d0af0bec6ef68e2bb.jpg'),
  ('b7d591b06bf93bfc83347f1c5fdc459d6b6c2a1e94492089bdc61c2ca53d35bf', 'migrations/photos/b7d591b06bf93bfc83347f1c5fdc459d6b6c2a1e94492089bdc61c2ca53d35bf.jpg'),
  ('3918b7dfebbfc10e876696cbbd0cc8e48ee8645ba04111d363854277b945dd2b', 'migrations/photos/3918b7dfebbfc10e876696cbbd0cc8e48ee8645ba04111d363854277b945dd2b.jpg'),
  ('a2f23a75e513affeafc993609ae42b2c3c01b8fe8eb9dee66e4c3005e27f3bac', 'migrations/photos/a2f23a75e513affeafc993609ae42b2c3c01b8fe8eb9dee66e4c3005e27f3bac.jpg'),
  ('134d91de24091f7fbba5aba6a1bd59d455fd995f4f937f1c8ad6d89b4fd11594', 'migrations/photos/134d91de24091f7fbba5aba6a1bd59d455fd995f4f937f1c8ad6d89b4fd11594.jpg'),
  ('a2c089a18022927e691f843c210011c4261130e70b430344f3550aadbd9966a2', 'migrations/photos/a2c089a18022927e691f843c210011c4261130e70b430344f3550aadbd9966a2.jpg'),
  ('16043fbd67dd28781e921b08518af1256e9988e99f5f86eb6acf58f9feb4a943', 'migrations/photos/16043fbd67dd28781e921b08518af1256e9988e99f5f86eb6acf58f9feb4a943.jpg'),
  ('7f37bf442374746fe1b009914932cdc417bcf2b3639db475c381a218b78dfb58', 'migrations/photos/7f37bf442374746fe1b009914932cdc417bcf2b3639db475c381a218b78dfb58.jpg'),
  ('e32021dcca02b4c2fd3862c2a8e0864b81a6fe661b1a43e672bdc7ae22c84d46', 'migrations/photos/e32021dcca02b4c2fd3862c2a8e0864b81a6fe661b1a43e672bdc7ae22c84d46.jpg'),
  ('9820f661b331842c2e117263745b563b627b274f472768f56226e972cad9e3fb', 'migrations/photos/9820f661b331842c2e117263745b563b627b274f472768f56226e972cad9e3fb.jpg'),
  ('ceb659a3c7909f47eacfdffb2f0bb555672a5877360ad863ae72e626e6978dce', 'migrations/photos/ceb659a3c7909f47eacfdffb2f0bb555672a5877360ad863ae72e626e6978dce.jpg'),
  ('61c25edd959d5bd70e52d5dcb8ca75b98daf604b3fab9f28d9a9378849cb8371', 'migrations/photos/61c25edd959d5bd70e52d5dcb8ca75b98daf604b3fab9f28d9a9378849cb8371.jpg'),
  ('1c8f4da5acbcbb65cf123933247e00cd612c271d498541981f79ad17f4b0ddda', 'migrations/photos/1c8f4da5acbcbb65cf123933247e00cd612c271d498541981f79ad17f4b0ddda.jpg'),
  ('4d1518ce28c5e5f9c4d8120b23dc908f992f14a186349b2496c4ba42c8115ae2', 'migrations/photos/4d1518ce28c5e5f9c4d8120b23dc908f992f14a186349b2496c4ba42c8115ae2.jpg'),
  ('95783b8c28db73360aeceb65cf14f18160833abbc775615980c994245908d86b', 'migrations/photos/95783b8c28db73360aeceb65cf14f18160833abbc775615980c994245908d86b.jpg'),
  ('91c4b5e2f2d278582cb6d06f2769698396d4ad4cfbd97d21c3c29a6b3dade033', 'migrations/photos/91c4b5e2f2d278582cb6d06f2769698396d4ad4cfbd97d21c3c29a6b3dade033.jpg'),
  ('6319386815fc532793fcdbf5acb2c08f8f681a8e1198c4e3040c42ccb7b86e58', 'migrations/photos/6319386815fc532793fcdbf5acb2c08f8f681a8e1198c4e3040c42ccb7b86e58.jpg'),
  ('392b70f165287548298a04a74282d9525abe330c5b19769bcf5953f175bb8102', 'migrations/photos/392b70f165287548298a04a74282d9525abe330c5b19769bcf5953f175bb8102.jpg'),
  ('a5b1f78432591fd6c29f2541ded7273b2d389ca00b39d9c5a78acccb053bcd04', 'migrations/photos/a5b1f78432591fd6c29f2541ded7273b2d389ca00b39d9c5a78acccb053bcd04.jpg'),
  ('1a217e3bdd6d1fffb23932c58b6b42056ec4b647675eeb997c81ed93a1dc4fab', 'migrations/photos/1a217e3bdd6d1fffb23932c58b6b42056ec4b647675eeb997c81ed93a1dc4fab.jpg'),
  ('b3ea265f616a2b447b9d6000e4c46af4b5fc8e55efe2135113ab4f1fab3f6083', 'migrations/photos/b3ea265f616a2b447b9d6000e4c46af4b5fc8e55efe2135113ab4f1fab3f6083.jpg'),
  ('2e0ed46ce520907a6d9c3032e226c559fc289575a57d893fdfb61735f2f88f4f', 'migrations/photos/2e0ed46ce520907a6d9c3032e226c559fc289575a57d893fdfb61735f2f88f4f.jpg'),
  ('79094380f8eb69ad813225ce7718d38d161f26e19ab9096ef1a6fa4ae2f3898a', 'migrations/photos/79094380f8eb69ad813225ce7718d38d161f26e19ab9096ef1a6fa4ae2f3898a.jpg'),
  ('bda08f9b697ec687d3a7b714636da0da38331c12038a311c8e1698f057c52656', 'migrations/photos/bda08f9b697ec687d3a7b714636da0da38331c12038a311c8e1698f057c52656.jpg'),
  ('463fbaaebb9fdcb0f8a1928b51097e38ae2cf10712e2d6e21f44768bd423e7ed', 'migrations/photos/463fbaaebb9fdcb0f8a1928b51097e38ae2cf10712e2d6e21f44768bd423e7ed.jpg'),
  ('1bdc91b9bb660a0894792b10f0a5ced05f8b183d3e1f7fab5528b392b5df0236', 'migrations/photos/1bdc91b9bb660a0894792b10f0a5ced05f8b183d3e1f7fab5528b392b5df0236.jpg'),
  ('3141c794058f1195a049a5cfbc0d7c7c7ee3c940d58dabe783dff4ae3543d362', 'migrations/photos/3141c794058f1195a049a5cfbc0d7c7c7ee3c940d58dabe783dff4ae3543d362.jpg'),
  ('6effebc17fe4ae898ce9d9d2e73bbd1896c94e016b888cb649692d876dc02f3a', 'migrations/photos/6effebc17fe4ae898ce9d9d2e73bbd1896c94e016b888cb649692d876dc02f3a.jpg'),
  ('085ee4cf5f8518f25b39dbd9cbb6d63cf5978b84ab08eac231df709b6eda0c08', 'migrations/photos/085ee4cf5f8518f25b39dbd9cbb6d63cf5978b84ab08eac231df709b6eda0c08.jpg'),
  ('aa5f5b5b042dfbf56498b5594269cd19174b3b88b1b5f0afdf2a2f115f6bec09', 'migrations/photos/aa5f5b5b042dfbf56498b5594269cd19174b3b88b1b5f0afdf2a2f115f6bec09.jpg'),
  ('6b980fed70f7767865914f7f265c7f948962cef2309eb36f23ec944ebaf56611', 'migrations/photos/6b980fed70f7767865914f7f265c7f948962cef2309eb36f23ec944ebaf56611.jpg'),
  ('0d9c0ba8d1827171ef681a27bc99aef4e8477b098a3e7468de934f74a6b200b5', 'migrations/photos/0d9c0ba8d1827171ef681a27bc99aef4e8477b098a3e7468de934f74a6b200b5.jpg'),
  ('8c6d220c9b83c53df3178ec038010343561c784b028b38e03d410be892c31781', 'migrations/photos/8c6d220c9b83c53df3178ec038010343561c784b028b38e03d410be892c31781.jpg'),
  ('4ede2a9a2f423007e57c54dd7772e36610f2ccd7072a3b5abc037aed5f9a2d32', 'migrations/photos/4ede2a9a2f423007e57c54dd7772e36610f2ccd7072a3b5abc037aed5f9a2d32.jpg'),
  ('b1529f730ca8ab832a6ca8eb12d67e58cd139c73906abda67be910a2ffa985a2', 'migrations/photos/b1529f730ca8ab832a6ca8eb12d67e58cd139c73906abda67be910a2ffa985a2.jpg'),
  ('9368cc71d33418d9d31a9c5a3538d50a217f7e2be8a70d9f66fa5d5801a1cdba', 'migrations/photos/9368cc71d33418d9d31a9c5a3538d50a217f7e2be8a70d9f66fa5d5801a1cdba.jpg'),
  ('c5a5a8d79baf32d42ef026408fe84dc95dec79fa859c2a9bdc1a2e24f0c088a1', 'migrations/photos/c5a5a8d79baf32d42ef026408fe84dc95dec79fa859c2a9bdc1a2e24f0c088a1.jpg'),
  ('05ccf375a569824b5c4e33cec691f52ee021f7771baf8df4b9f3363ebf17fde8', 'migrations/photos/05ccf375a569824b5c4e33cec691f52ee021f7771baf8df4b9f3363ebf17fde8.jpg'),
  ('8553f67769b6977a0c140e7803860c1fdbc9e0008693a606577928298055eaa7', 'migrations/photos/8553f67769b6977a0c140e7803860c1fdbc9e0008693a606577928298055eaa7.jpg'),
  ('0e929b45c16c973f195cefd54069217965bcc8d0b1e205fd1ad1d2d143c879ff', 'migrations/photos/0e929b45c16c973f195cefd54069217965bcc8d0b1e205fd1ad1d2d143c879ff.jpg'),
  ('3d62dec14e03a014204028d56d1c73e8d3394ccd37a7e33664126696a9744b8e', 'migrations/photos/3d62dec14e03a014204028d56d1c73e8d3394ccd37a7e33664126696a9744b8e.jpg'),
  ('84b7294d8bc4892a9aefd9c649ad207cf4f94b4cb5d79cdb6dc6770d8b2bc750', 'migrations/photos/84b7294d8bc4892a9aefd9c649ad207cf4f94b4cb5d79cdb6dc6770d8b2bc750.jpg'),
  ('a496a386c922e4fa9a00d2fd750d604cb0f7ae352733f5dc19917c010f55b056', 'migrations/photos/a496a386c922e4fa9a00d2fd750d604cb0f7ae352733f5dc19917c010f55b056.jpg'),
  ('ef667c9d78d260906132979f244f8de47af922cb251d9f660549549df1d899ed', 'migrations/photos/ef667c9d78d260906132979f244f8de47af922cb251d9f660549549df1d899ed.jpg'),
  ('8247e0568e2e4bc306465bbd355e750756f925918bb7cd0fdf7b5ed836821886', 'migrations/photos/8247e0568e2e4bc306465bbd355e750756f925918bb7cd0fdf7b5ed836821886.jpg'),
  ('5b8e48298ff3a359b4663691c3dd5598ae2db08a475cc3d97ebc67a0a50ce33e', 'migrations/photos/5b8e48298ff3a359b4663691c3dd5598ae2db08a475cc3d97ebc67a0a50ce33e.jpg'),
  ('62abe71c1e41ca0ade614b8f436978eb79c0a5d8e0e55b8f9a33241ebf39620f', 'migrations/photos/62abe71c1e41ca0ade614b8f436978eb79c0a5d8e0e55b8f9a33241ebf39620f.jpg'),
  ('01bba6aa393bddbe06a962f763349ec1e792f40f30cbea8e23d72f6ed3c7a95d', 'migrations/photos/01bba6aa393bddbe06a962f763349ec1e792f40f30cbea8e23d72f6ed3c7a95d.jpg'),
  ('707fb18716257d6ebab3bca0b4b5cc240ee2175f40460839f18f4730cd19ba61', 'migrations/photos/707fb18716257d6ebab3bca0b4b5cc240ee2175f40460839f18f4730cd19ba61.jpg'),
  ('774930a0a9f2ad1e0022160406b229d3be192ab6cb91901e391d31fdf0f0b738', 'migrations/photos/774930a0a9f2ad1e0022160406b229d3be192ab6cb91901e391d31fdf0f0b738.jpg'),
  ('a727c89ae39996b9283f0c2f3e6dd27678b86347fa0c2d9adafe4c58b4446d39', 'migrations/photos/a727c89ae39996b9283f0c2f3e6dd27678b86347fa0c2d9adafe4c58b4446d39.jpg'),
  ('f529c014929f0d1d119cea4faf4111617e4d45f19f24f4a74405907fb235efd0', 'migrations/photos/f529c014929f0d1d119cea4faf4111617e4d45f19f24f4a74405907fb235efd0.jpg'),
  ('22f7baa32019a1bbe442e6f10db9db78ce5bf5d32a4d8786f959b2f2357d710a', 'migrations/photos/22f7baa32019a1bbe442e6f10db9db78ce5bf5d32a4d8786f959b2f2357d710a.jpg'),
  ('2f5a23d2a5fee814216e0664034c2c615ec4a776af41691074af705c3d3baf85', 'migrations/photos/2f5a23d2a5fee814216e0664034c2c615ec4a776af41691074af705c3d3baf85.jpg'),
  ('dc582b7dc43681c7a5070a7605dbe89299e0070674c7c60d007436e812a2702c', 'migrations/photos/dc582b7dc43681c7a5070a7605dbe89299e0070674c7c60d007436e812a2702c.jpg'),
  ('226d5f1e5626972d0fea94218d746c5c0ffdda92b5b4871a439c94005ac2fea7', 'migrations/photos/226d5f1e5626972d0fea94218d746c5c0ffdda92b5b4871a439c94005ac2fea7.jpg'),
  ('bf5377184223f63dcda51db2ca732438d8abea6c0645263137572edac97eca54', 'migrations/photos/bf5377184223f63dcda51db2ca732438d8abea6c0645263137572edac97eca54.jpg'),
  ('5bf26a6080be0e710941c197d4de67697a778dc80fcd3bc1f02bc3bf775e30d7', 'migrations/photos/5bf26a6080be0e710941c197d4de67697a778dc80fcd3bc1f02bc3bf775e30d7.jpg'),
  ('853153582f366d4ae158232755482abd3a1aeab87588ba3817c862d10ffe82cc', 'migrations/photos/853153582f366d4ae158232755482abd3a1aeab87588ba3817c862d10ffe82cc.jpg'),
  ('aca97f853e5d79667d908e18fec5b7b0762d7ec113a7be82da843a6713bc4c38', 'migrations/photos/aca97f853e5d79667d908e18fec5b7b0762d7ec113a7be82da843a6713bc4c38.jpg'),
  ('9709aadfdd86fc17b70cc652c386b05711800fb50f57c839464d8821bc09e07f', 'migrations/photos/9709aadfdd86fc17b70cc652c386b05711800fb50f57c839464d8821bc09e07f.jpg'),
  ('f29a7db12f8529b6378c42971f67e9086fd60ff3101065cff0acfa3effa64b37', 'migrations/photos/f29a7db12f8529b6378c42971f67e9086fd60ff3101065cff0acfa3effa64b37.jpg'),
  ('05fb32b4059e65311aa8f53fdce6349f912a54ffb6b668673f12b53802fee6c7', 'migrations/photos/05fb32b4059e65311aa8f53fdce6349f912a54ffb6b668673f12b53802fee6c7.jpg'),
  ('804cf57c49320b6be83b40eaf2e7052a14ef08afda5e98abd950b6ed1a015ee2', 'migrations/photos/804cf57c49320b6be83b40eaf2e7052a14ef08afda5e98abd950b6ed1a015ee2.jpg'),
  ('2b582e090a76b2ac7436f9fc90377d6fe4b6c8234e7ef87b75dc23211469001f', 'migrations/photos/2b582e090a76b2ac7436f9fc90377d6fe4b6c8234e7ef87b75dc23211469001f.jpg'),
  ('e6e7ac71d60bee449fa9a7aa14606608f839f5b1846c4d721bc1761fc0c87b00', 'migrations/photos/e6e7ac71d60bee449fa9a7aa14606608f839f5b1846c4d721bc1761fc0c87b00.jpg'),
  ('9fd5bab784b534df8d4d08c6e46d39ba391dbed6bbcdd8142b30e8c35e981f82', 'migrations/photos/9fd5bab784b534df8d4d08c6e46d39ba391dbed6bbcdd8142b30e8c35e981f82.jpg'),
  ('c1d701563f6fa928f15b1ba02e6a54f5dcba62f4b9bf35cbcecdc277596a8faa', 'migrations/photos/c1d701563f6fa928f15b1ba02e6a54f5dcba62f4b9bf35cbcecdc277596a8faa.jpg'),
  ('49fa3135f34aef99411ce172b422999a421dc8e31cf1f01706b8e6cc794270a0', 'migrations/photos/49fa3135f34aef99411ce172b422999a421dc8e31cf1f01706b8e6cc794270a0.jpg');

UPDATE ai_route_images i
   SET s3_key = k.s3_key, image_data = NULL
  FROM _migration_photo_keys k
 WHERE i.image_data IS NOT NULL
   AND encode(sha256(i.image_data), 'hex') = k.sha256;

UPDATE place_gallery_photos g
   SET s3_key = k.s3_key, image_data = NULL
  FROM _migration_photo_keys k
 WHERE g.image_data IS NOT NULL
   AND encode(sha256(g.image_data), 'hex') = k.sha256;

DO $$
DECLARE
  v_hero_keyed  int;
  v_gal_keyed   int;
  v_hero_bytes  int;
  v_gal_bytes   int;
BEGIN
  SELECT count(*) INTO v_hero_keyed FROM ai_route_images WHERE s3_key LIKE 'migrations/photos/%';
  SELECT count(*) INTO v_gal_keyed  FROM place_gallery_photos WHERE s3_key LIKE 'migrations/photos/%';
  SELECT count(*) INTO v_hero_bytes FROM ai_route_images WHERE image_data IS NOT NULL;
  SELECT count(*) INTO v_gal_bytes  FROM place_gallery_photos WHERE image_data IS NOT NULL;
  RAISE NOTICE '[1228] снимки из миграций в хранилище: герой % строк, галерея % строк; ещё с байтами: герой %, галерея %',
    v_hero_keyed, v_gal_keyed, v_hero_bytes, v_gal_bytes;
END $$;

DROP TABLE IF EXISTS _migration_photo_keys;
