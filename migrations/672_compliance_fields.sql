-- Migration 672: Legal compliance fields
-- partners: INN, OGRN, EFRT number for tour operators (132-FZ, 447-FZ)
-- users: marketing_consent (38-FZ separate from pd_consent)

-- partners table
ALTER TABLE partners ADD COLUMN IF NOT EXISTS company_inn     VARCHAR(12);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS company_ogrn    VARCHAR(15);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS legal_address   TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS efrt_number     VARCHAR(50);

COMMENT ON COLUMN partners.company_inn   IS '132-ФЗ/447-ФЗ: ИНН туроператора';
COMMENT ON COLUMN partners.company_ogrn  IS '132-ФЗ: ОГРН/ОГРНИП туроператора';
COMMENT ON COLUMN partners.legal_address IS '447-ФЗ: юридический адрес для отображения на странице тура';
COMMENT ON COLUMN partners.efrt_number   IS '132-ФЗ: номер в ЕФРТ (Едином федеральном реестре туроператоров)';

-- operator_applications: collect legal data at registration time
ALTER TABLE operator_applications ADD COLUMN IF NOT EXISTS company_inn    VARCHAR(12);
ALTER TABLE operator_applications ADD COLUMN IF NOT EXISTS company_ogrn   VARCHAR(15);
ALTER TABLE operator_applications ADD COLUMN IF NOT EXISTS efrt_number    VARCHAR(50);

-- users: separate marketing consent (38-FZ)
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN users.marketing_consent IS '38-ФЗ: согласие на получение рекламных сообщений (отдельно от pd_consent)';
