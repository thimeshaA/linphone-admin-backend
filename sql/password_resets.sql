-- This project has no migration tooling (see models/adminModel.js and
-- config/db.js — every table is raw SQL against mysql2 pools). Run this
-- manually against the ADMIN_DB_NAME database before deploying the
-- forgot/reset-password feature. Adjust admin_id's type/FK if `admins.id`
-- isn't an INT AUTO_INCREMENT PRIMARY KEY in your actual schema.

CREATE TABLE IF NOT EXISTS password_resets (
  id INT NOT NULL AUTO_INCREMENT,
  admin_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token_hash (token_hash),
  KEY idx_password_resets_admin_id (admin_id),
  CONSTRAINT fk_password_resets_admin_id FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
);
