const sql = require('mssql');
let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(process.env.SQL_CONNECTION_STRING); // set in Azure app settings, never in code
  return pool;
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const handler = fn => async (req, ctx) => {
  try { return await fn(req, ctx); }
  catch (e) {
    ctx.error(e);
    return { status: e.status || 500, jsonBody: { error: e.status ? e.message : 'Server error' } };
  }
};
module.exports = { sql, getPool, fail, handler };
