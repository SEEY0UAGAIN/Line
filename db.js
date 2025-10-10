const mysql = require('mysql2/promise');
require('dotenv').config();

const db1Config = {
  host: process.env.DB1_HOST,
  user: process.env.DB1_USER,
  password: process.env.DB1_PASS,
  database: process.env.DB1_NAME
};

const db2Config = {
  host: process.env.DB2_HOST,
  user: process.env.DB2_USER,
  password: process.env.DB2_PASS,
  database: process.env.DB2_NAME
};

async function queryDB1(sql, params) {
  const conn = await mysql.createConnection(db1Config);
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

async function queryDB2(sql, params) {
  const conn = await mysql.createConnection(db2Config);
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = { queryDB1, queryDB2 };
