require('dotenv').config();
const mysql = require('mysql2/promise');

const flexisipPool = mysql.createPool({
  host: process.env.FLEXISIP_DB_HOST,
  port: process.env.FLEXISIP_DB_PORT,
  user: process.env.FLEXISIP_DB_USER,
  password: process.env.FLEXISIP_DB_PASSWORD,
  database: process.env.FLEXISIP_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const adminPool = mysql.createPool({
  host: process.env.ADMIN_DB_HOST,
  port: process.env.ADMIN_DB_PORT,
  user: process.env.ADMIN_DB_USER,
  password: process.env.ADMIN_DB_PASSWORD,
  database: process.env.ADMIN_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = { flexisipPool, adminPool };
