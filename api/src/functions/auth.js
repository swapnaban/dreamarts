const { app } = require('@azure/functions');
const { sql, getPool, fail, handler } = require('../db');
const { hmac, newToken, code6, same, userFromToken, sendCode } = require('../auth');
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const email = v => { v = clean(v, 256).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw fail(400, 'Invalid email'); return v; };

// Step 1: ask for a code. Always answers ok so nobody can discover which emails have accounts.
app.http('authRequest', { methods: ['POST'], route: 'auth/request', authLevel: 'anonymous', handler: handler(async req => {
  const e = email((await req.json()).email);
  const pool = await getPool();
  await pool.request().query('DELETE dbo.LoginCodes WHERE ExpiresAt < DATEADD(DAY,-1,SYSUTCDATETIME()); DELETE dbo.AuthSessions WHERE ExpiresAt < SYSUTCDATETIME();');
  const u = await pool.request().input('e', sql.NVarChar(256), e).query('SELECT 1 AS x FROM dbo.Users WHERE Email=@e AND IsActive=1');
  if (u.recordset.length) {
    const n = await pool.request().input('e', sql.NVarChar(256), e).query('SELECT COUNT(*) AS n FROM dbo.LoginCodes WHERE Email=@e AND CreatedAt > DATEADD(HOUR,-1,SYSUTCDATETIME())');
    const recent = await pool.request().input('e', sql.NVarChar(256), e).query('SELECT COUNT(*) AS n FROM dbo.LoginCodes WHERE Email=@e AND CreatedAt > DATEADD(SECOND,-60,SYSUTCDATETIME())');
    if (recent.recordset[0].n === 0 && n.recordset[0].n < 5) {   // one code per 60 seconds and at most 5 per hour, only ever sent to the address that asked (and only if it is an approved account)
      const code = code6();
      await pool.request().input('e', sql.NVarChar(256), e).input('h', sql.Char(64), hmac(`${e}:${code}`))
        .query('INSERT dbo.LoginCodes (Email, CodeHash, ExpiresAt) VALUES (@e, @h, DATEADD(MINUTE,10,SYSUTCDATETIME()))');
      await sendCode(e, code);
    }
  }
  return { jsonBody: { ok: true } };
}) });

// Step 2: check the code, start a 7-day session
app.http('authVerify', { methods: ['POST'], route: 'auth/verify', authLevel: 'anonymous', handler: handler(async req => {
  const b = await req.json();
  const e = email(b.email), code = clean(b.code, 6);
  if (!/^\d{6}$/.test(code)) throw fail(400, 'Enter the 6-digit code');
  const pool = await getPool();
  const r = await pool.request().input('e', sql.NVarChar(256), e).query(
    'SELECT TOP 1 CodeId, CodeHash, Attempts FROM dbo.LoginCodes WHERE Email=@e AND UsedAt IS NULL AND ExpiresAt > SYSUTCDATETIME() ORDER BY CreatedAt DESC');
  const row = r.recordset[0];
  if (!row || row.Attempts >= 5) throw fail(401, 'That code has expired. Please request a new one.');
  await pool.request().input('id', sql.Int, row.CodeId).query('UPDATE dbo.LoginCodes SET Attempts = Attempts + 1 WHERE CodeId=@id');
  if (!same(hmac(`${e}:${code}`), row.CodeHash.trim())) throw fail(401, 'Wrong code. Please try again.');
  await pool.request().input('id', sql.Int, row.CodeId).query('UPDATE dbo.LoginCodes SET UsedAt = SYSUTCDATETIME() WHERE CodeId=@id');
  const u = await pool.request().input('e', sql.NVarChar(256), e).query(
    'UPDATE dbo.Users SET EmailVerifiedAt = COALESCE(EmailVerifiedAt, SYSUTCDATETIME()), LastLoginAt = SYSUTCDATETIME() OUTPUT INSERTED.UserId, INSERTED.FirstName WHERE Email=@e AND IsActive=1');
  if (!u.recordset.length) throw fail(401, 'Account not found');
  const token = newToken();
  await pool.request().input('h', sql.Char(64), hmac(token)).input('u', sql.Int, u.recordset[0].UserId)
    .query('INSERT dbo.AuthSessions (TokenHash, UserId, ExpiresAt) VALUES (@h, @u, DATEADD(DAY,7,SYSUTCDATETIME()))');
  return { jsonBody: { ok: true, token, name: u.recordset[0].FirstName } };
}) });

app.http('authLogout', { methods: ['POST'], route: 'auth/logout', authLevel: 'anonymous', handler: handler(async req => {
  const t = req.headers.get('x-da-token');
  if (t) await (await getPool()).request().input('h', sql.Char(64), hmac(t)).query('DELETE dbo.AuthSessions WHERE TokenHash=@h');
  return { jsonBody: { ok: true } };
}) });

