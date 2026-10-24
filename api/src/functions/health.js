const { app } = require('@azure/functions');
const { getPool } = require('../db');
// Diagnostic only: reports which settings exist (true/false, never values) and the database error CODE. Delete after setup.
app.http('health', { methods: ['GET'], route: 'health', authLevel: 'anonymous', handler: async () => {
  const has = k => !!process.env[k];
  const out = { settings: { SQL_CONNECTION_STRING: has('SQL_CONNECTION_STRING'), AUTH_SECRET: has('AUTH_SECRET'), ACS_CONNECTION_STRING: has('ACS_CONNECTION_STRING'), EMAIL_SENDER: has('EMAIL_SENDER') } };
  try {
    const r = await (await getPool()).request().query("SELECT (SELECT COUNT(*) FROM dbo.Sessions) AS sessions, OBJECT_ID('dbo.vw_SessionCapacity') AS viewId, OBJECT_ID('dbo.LoginCodes') AS loginCodesId");
    out.db = { ok: true, ...r.recordset[0] };
  } catch (e) { out.db = { ok: false, code: e.code || null, number: e.number || (e.originalError && e.originalError.number) || null }; }
  return { jsonBody: out };
} });
