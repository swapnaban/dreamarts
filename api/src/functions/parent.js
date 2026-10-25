const { app } = require('@azure/functions');
const { sql, getPool, fail, handler } = require('../db');
const { userFromToken } = require('../auth');
const clean = (v, m) => String(v ?? '').trim().slice(0, m);
const need = async req => { const me = await userFromToken(req); if (!me) throw fail(401, 'Please log in'); return me; };
const par = (name, method, route, fn) => app.http(name, { methods: [method], route, authLevel: 'anonymous', handler: handler(fn) });

// Everything the logged-in parent may see: only their own rows
par('me', 'GET', 'me', async req => {
  const me = await need(req);
  const pool = await getPool(), q = () => pool.request().input('u', sql.Int, me.UserId);
  const [students, enrollments, payments, requests, settings] = await Promise.all([
    q().query('SELECT StudentId, FullName, Age, Level FROM dbo.Students WHERE ParentUserId=@u ORDER BY StudentId'),
    q().query(`SELECT e.EnrollmentId, e.SessionId, st.FullName AS Student, e.Status, s.DayOfWeek, CONVERT(VARCHAR(5),s.StartTime,108) AS StartTime,
                      CONVERT(VARCHAR(5),s.EndTime,108) AS EndTime, a.Name AS ArtType, p.Name AS PlanName
               FROM dbo.Enrollments e JOIN dbo.Students st ON st.StudentId=e.StudentId JOIN dbo.Sessions s ON s.SessionId=e.SessionId
               LEFT JOIN dbo.ArtTypes a ON a.ArtTypeId=e.ArtTypeId JOIN dbo.Plans p ON p.PlanId=e.PlanId
               WHERE st.ParentUserId=@u ORDER BY e.EnrolledAt DESC`),
    q().query('SELECT PaymentId, Description, Amount, Method, Status, CreatedAt, PaidAt FROM dbo.Payments WHERE UserId=@u ORDER BY CreatedAt DESC'),
    q().query(`SELECT c.RequestId, c.RequestType, c.Status, c.Message, c.AdminNote, c.CreatedAt, CONVERT(VARCHAR(10),c.ClassDate,23) AS ClassDate
               FROM dbo.ChangeRequests c WHERE c.UserId=@u ORDER BY c.CreatedAt DESC`),
    pool.request().query("SELECT SettingKey, SettingValue FROM dbo.Settings WHERE SettingKey IN ('zellePhone','zelleQrImageId')")]);
  const m = Object.fromEntries(settings.recordset.map(v => [v.SettingKey, v.SettingValue]));
  return { jsonBody: { name: me.FirstName, email: me.Email, phone: me.Phone, students: students.recordset, enrollments: enrollments.recordset,
    payments: payments.recordset, requests: requests.recordset, zelle: { phone: m.zellePhone || '', qrImageId: m.zelleQrImageId || '' } } };
});

// Ask for a schedule change, an additional class, or a make-up for a missed class
par('meRequest', 'POST', 'me/requests', async req => {
  const me = await need(req), b = await req.json();
  if (!['ScheduleChange', 'AdditionalClass', 'MissedClass'].includes(b.type)) throw fail(400, 'Bad request type');
  const pool = await getPool();
  let enrollmentId = Number(b.enrollmentId) || null;
  if (enrollmentId) {                                    // must be this parent's own enrollment
    const own = await pool.request().input('e', sql.Int, enrollmentId).input('u', sql.Int, me.UserId)
      .query('SELECT 1 AS x FROM dbo.Enrollments e JOIN dbo.Students s ON s.StudentId=e.StudentId WHERE e.EnrollmentId=@e AND s.ParentUserId=@u');
    if (!own.recordset.length) throw fail(403, 'Not your enrollment');
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.classDate || '') ? b.classDate : null;
  await pool.request().input('u', sql.Int, me.UserId).input('e', sql.Int, enrollmentId).input('t', sql.NVarChar(20), b.type)
    .input('p', sql.Int, Number(b.preferredSessionId) || null).input('d', sql.Date, date).input('m', sql.NVarChar(1000), clean(b.message, 1000))
    .query('INSERT dbo.ChangeRequests (UserId, EnrollmentId, RequestType, PreferredSessionId, ClassDate, Message) VALUES (@u,@e,@t,@p,@d,@m)');
  return { status: 201, jsonBody: { ok: true } };
});

// "I have sent the Zelle payment"
par('mePaymentSubmitted', 'POST', 'me/payments/{id}/submitted', async req => {
  const me = await need(req);
  await (await getPool()).request().input('id', sql.Int, Number(req.params.id)).input('u', sql.Int, me.UserId)
    .query("UPDATE dbo.Payments SET Status='Submitted' WHERE PaymentId=@id AND UserId=@u AND Status='Pending'");
  return { jsonBody: { ok: true } };
});
