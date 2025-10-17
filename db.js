const mysql = require('mysql2/promise');
const sql = require('mssql');
require('dotenv').config();

// ----- DB1: SQL Server -----
const db1Config = {
  server: process.env.DB1_HOST,
  database: process.env.DB1_NAME,
  user: process.env.DB1_USER,
  password: process.env.DB1_PASS,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

let pool;

async function connectDB1() {
  if (!pool) {
    pool = await sql.connect(db1Config);
    console.log('Connected to SQL Server DB1');
  }
  return pool;
}

// queryDB1 รองรับ named parameters
async function queryDB1(sqlQuery, params = {}) {
  const pool = await connectDB1();
  const request = pool.request();

  // เพิ่ม parameter เข้า request
  for (const key in params) {
    request.input(key, params[key].type, params[key].value);
  }

  const result = await request.query(sqlQuery);
  return result.recordset; // คืน array ของ rows
}

// ----- DB2: MySQL -----
const db2Config = {
    host: process.env.DB2_HOST,
    user: process.env.DB2_USER,
    password: process.env.DB2_PASS,
    database: process.env.DB2_NAME
};

async function queryDB2(queryText, params = []) {
    const conn = await mysql.createConnection(db2Config);
    try {
        const [rows] = await conn.execute(queryText, params);
        return rows;
    } finally {
        await conn.end();
    }
}

// ----- DB2: MySQL -----
const db3Config = {
    host: process.env.DB3_HOST, 
    user: process.env.DB3_USER,
    password: process.env.DB3_PASS,
    database: process.env.DB3_NAME
};

async function queryDB3(queryText, params = []) {
    const conn = await mysql.createConnection(db3Config);
    try {
        const [rows] = await conn.execute(queryText, params);
        return rows;
    } finally {
        await conn.end();
    }
}

module.exports = { queryDB1, queryDB2, queryDB3 };
