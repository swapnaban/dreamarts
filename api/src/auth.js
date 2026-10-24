const crypto = require('crypto');
const { sql, getPool, fail } = require('./db');
const secret = () => { const s = process.env.AUTH_SECRET; if (!s || s.length < 32) throw new Error('AUTH_SECRET app setting missing or too short'); return s; };
const hmac = v => crypto.createHmac('sha256', secret()).update(v).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const code6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The browser sends the session token in the x-da-token header (Authorization is reserved by Static Web Apps).
async function userFromToken(req) {
  const t = req.headers.get('x-da-token');
  if (!t || t.length > 100) return null;
  const r = await (await getPool()).request().input('h', sql.Char(64), hmac(t)).query(
    `SELECT u.UserId, u.Email, u.FirstName, u.Phone FROM dbo.AuthSessions a JOIN dbo.Users u ON u.UserId = a.UserId
     WHERE a.TokenHash = @h AND a.ExpiresAt > SYSUTCDATETIME() AND u.IsActive = 1`);
  return r.recordset[0] || null;
}

async function sendMail(to, subject, text) {
  if (!process.env.ACS_CONNECTION_STRING || !process.env.EMAIL_SENDER) throw fail(503, 'Email sending is not configured');
  const { EmailClient } = require('@azure/communication-email');
  await new EmailClient(process.env.ACS_CONNECTION_STRING).beginSend({
    senderAddress: process.env.EMAIL_SENDER, content: { subject, plainText: text }, recipients: { to: [{ address: to }] } });
}
// Admin = has the SWA role "admin" (portal invitation) OR is signed in with an account listed in the ADMIN_EMAILS app setting
// (comma-separated, matched against the sign-in name shown at /.auth/me as userDetails).
const adminList = () => (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = req => {
  const h = req.headers.get('x-ms-client-principal');
  try {
    const p = JSON.parse(Buffer.from(h, 'base64').toString('utf8')), roles = p.userRoles || [];
    return roles.includes('admin') || (roles.includes('authenticated') && adminList().includes(String(p.userDetails || '').toLowerCase()));
  } catch { return false; }
};
const requireAdmin = req => { if (!isAdmin(req)) throw fail(403, 'Admin only'); };

async function sendCode(to, code) {
  if (!process.env.ACS_CONNECTION_STRING || !process.env.EMAIL_SENDER) throw fail(503, 'Email sending is not configured');
  const { EmailClient } = require('@azure/communication-email');
  const client = new EmailClient(process.env.ACS_CONNECTION_STRING);
  await client.beginSend({
    senderAddress: process.env.EMAIL_SENDER,
    content: { subject: 'Your Dream Arts login code', plainText: `Your Dream Arts login code is ${code}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.` },
    recipients: { to: [{ address: to }] }
  });
}
module.exports = { hmac, newToken, code6, same, userFromToken, sendCode, sendMail, isAdmin, requireAdmin };
