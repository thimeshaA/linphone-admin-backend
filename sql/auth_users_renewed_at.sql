-- This project has no migration tooling (see models/accountModel.js and
-- config/db.js — every table is raw SQL against mysql2 pools). Run this
-- manually against the FLEXISIP_DB_NAME database before deploying the
-- reports feature: without this column there is no way to tell whether an
-- account was renewed within a given reporting period.

ALTER TABLE auth_users
  ADD COLUMN renewed_at DATETIME NULL DEFAULT NULL AFTER expired_at;
