-- Bundled definition of the `accounts` table.
--
-- Used only by the opt-in AUTO_CREATE_SCHEMA startup check (see
-- db/ensureAccountsSchema.js) to create the table on a fresh, empty
-- local/test database - never applied automatically in production. The
-- database itself is expected to already exist; this file only creates the
-- table.
--
-- Columns registerID..scadenza_updated (11) are the supervisor's original
-- columns, reproduced exactly from `SHOW CREATE TABLE accounts` against the
-- real production database on 2026-09-29 - do not change their types or
-- defaults here without re-confirming against production.
--
-- AUTO_INCREMENT=2374 (production's current counter position) is
-- deliberately omitted - that reflects the row count of an existing table,
-- not part of the table's definition, and a freshly created local/test
-- table should start counting at 1.
--
-- creator_id / email / disabled_at / renewed_at are the 4 additive columns
-- from the accounts-schema-migration branch. Their types are this
-- migration's own choice, not part of the supervisor's original schema:
-- creator_id is char(36) to match admins.id (UUID, see the admins.id UUID
-- migration). Applying these 4 columns to an *existing* production table is
-- handled separately and manually via `npm run db:ensure-columns` - this
-- file is never used for that.
CREATE TABLE accounts (
  registerID int(10) unsigned NOT NULL AUTO_INCREMENT,
  login varchar(20) NOT NULL,
  domain varchar(50) NOT NULL DEFAULT 'flexi.kryptoline.com',
  authid varchar(20) NOT NULL,
  password varchar(200) NOT NULL,
  algorithm varchar(10) NOT NULL DEFAULT 'SHA-256',
  phone varchar(20) NOT NULL,
  scadenza varchar(10) NOT NULL DEFAULT '2000-01-01',
  ksuite varchar(1) NOT NULL DEFAULT 'N',
  creazione varchar(10) NOT NULL DEFAULT '1999-12-31',
  scadenza_updated varchar(1) NOT NULL DEFAULT 'N',
  creator_id char(36) DEFAULT NULL,
  email varchar(255) DEFAULT NULL,
  disabled_at datetime DEFAULT NULL,
  renewed_at datetime DEFAULT NULL,
  PRIMARY KEY (registerID)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;
