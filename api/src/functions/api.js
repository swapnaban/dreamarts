const { app } = require('@azure/functions');
const { sql, getPool, fail, handler } = require('../db');
const { userFromToken, requireAdmin } = require('../auth');
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const email = v => { v = clean(v, 256).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw fail(400, 'Invalid email'); return v; };


// ---------- public ----------
app.http('sessions', { methods: ['GET'], route: 'sessions', authLevel: 'anonymous', handler: handler(async () => {
  const r = await (await getPool()).request().query(`
    SELECT SessionId, DayOfWeek, CONVERT(VARCHAR(5),StartTime,108) AS StartTime, CONVERT(VARCHAR(5),EndTime,108) AS EndTime,
           AgeGroup, Capacity, Enrolled, SeatsLeft
    FROM dbo.vw_SessionCapacity v WHERE EXISTS (SELECT 1 FROM dbo.Sessions s WHERE s.SessionId=v.SessionId AND s.IsActive=1)
    ORDER BY DayOfWeek, StartTime`);
  return { jsonBody: r.recordset };
}) });

app.http('arttypes', { methods: ['GET'], route: 'arttypes', authLevel: 'anonymous', handler: handler(async () => {
  const r = await (await getPool()).request().query('SELECT ArtTypeId, Name, Description FROM dbo.ArtTypes WHERE IsActive=1 ORDER BY ArtTypeId');
  return { jsonBody: r.recordset };
}) });

app.http('plans', { methods: ['GET'], route: 'plans', authLevel: 'anonymous', handler: handler(async () => {
  const r = await (await getPool()).request().query('SELECT PlanId, Name, Price, Description, ClassCount FROM dbo.Plans WHERE IsActive=1 ORDER BY Price');
  return { jsonBody: r.recordset };
}) });

// Enrollment: parent user + student + enrollment + pending payment, all in one transaction
app.http('register', { methods: ['POST'], route: 'register', authLevel: 'anonymous', handler: handler(async req => {
  const b = await req.json();
  const me = await userFromToken(req);                       // logged-in parent: use their verified email
  const parentEmail = me ? me.Email : email(b.email);
  if (!me) {                                                   // an email that already has an account must log in first
    const ex = await (await getPool()).request().input('e', sql.NVarChar(256), parentEmail).query('SELECT 1 AS x FROM dbo.Users WHERE Email=@e AND IsActive=1');
    if (ex.recordset.length) throw fail(401, 'login_required');   // inactive = still awaiting approval, may add another child
  }
  const student = clean(b.student, 120), parent = clean(b.parent, 160), phone = clean(b.phone, 30);
  const age = Number(b.age), sessionId = Number(b.sessionId), artTypeId = Number(b.artTypeId) || null, planId = Number(b.planId);
  if (!student || !parent || !(age >= 3 && age <= 18) || !sessionId || !planId) throw fail(400, 'Missing or invalid fields');
  const level = ['Beginner', 'Some experience', 'Advanced'].includes(b.level) ? b.level : 'Beginner';

  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  const rq = () => new sql.Request(tx);
  try {
    // lock the session row so two parents cannot take the last seat at the same time
    const s = await rq().input('id', sql.Int, sessionId).query('SELECT Capacity FROM dbo.Sessions WITH (UPDLOCK, HOLDLOCK) WHERE SessionId=@id AND IsActive=1');
    if (!s.recordset.length) throw fail(404, 'Session not found');
    const c = await rq().input('id', sql.Int, sessionId).query("SELECT COUNT(*) AS n FROM dbo.Enrollments WHERE SessionId=@id AND Status IN ('Pending','Active')");
    if (c.recordset[0].n >= s.recordset[0].Capacity) throw fail(409, 'full');

    const pl = await rq().input('p', sql.SmallInt, planId).query('SELECT Name, Price FROM dbo.Plans WHERE PlanId=@p AND IsActive=1');
    if (!pl.recordset.length) throw fail(400, 'Unknown plan');

    let u = await rq().input('e', sql.NVarChar(256), parentEmail).query('SELECT UserId FROM dbo.Users WHERE Email=@e');
    let userId = u.recordset[0]?.UserId;
    if (!userId) {
      u = await rq().input('e', sql.NVarChar(256), parentEmail).input('f', sql.NVarChar(80), parent.slice(0, 80)).input('ph', sql.NVarChar(30), phone)
        .query('INSERT dbo.Users (RoleId, Email, FirstName, Phone, IsActive) OUTPUT INSERTED.UserId VALUES (2, @e, @f, @ph, 0)'); // RoleId 2 = User
      userId = u.recordset[0].UserId;
    }
    const st = await rq().input('u', sql.Int, userId).input('n', sql.NVarChar(120), student).input('a', sql.TinyInt, age)
      .input('l', sql.NVarChar(30), level).input('no', sql.NVarChar(1000), clean(b.notes, 1000))
      .query('INSERT dbo.Students (ParentUserId, FullName, Age, Level, Notes) OUTPUT INSERTED.StudentId VALUES (@u,@n,@a,@l,@no)');
    const en = await rq().input('s', sql.Int, st.recordset[0].StudentId).input('se', sql.Int, sessionId)
      .input('at', sql.SmallInt, artTypeId).input('p', sql.SmallInt, planId)
      .query('INSERT dbo.Enrollments (StudentId, SessionId, ArtTypeId, PlanId, Status) OUTPUT INSERTED.EnrollmentId VALUES (@s,@se,@at,@p,\'Pending\')');
    await tx.commit();
    return { status: 201, jsonBody: { ok: true, enrollmentId: en.recordset[0].EnrollmentId } };
  } catch (e) {
    await tx.rollback().catch(() => {});
    if (e.number === 2627 || e.number === 2601) throw fail(409, 'This student is already enrolled in that session');
    throw e;
  }
}) });

// ---------- admin ----------
app.http('adminEnrollments', { methods: ['GET'], route: 'manage/enrollments', authLevel: 'anonymous', handler: handler(async req => {
  requireAdmin(req);
  const r = await (await getPool()).request().query(`
    SELECT e.EnrollmentId, e.SessionId, e.Status, e.EnrolledAt, st.FullName AS Student, st.Age, u.FirstName AS Parent, u.Email, u.Phone,
           s.DayOfWeek, CONVERT(VARCHAR(5),s.StartTime,108) AS StartTime, CONVERT(VARCHAR(5),s.EndTime,108) AS EndTime,
           a.Name AS ArtType, p.Name AS PlanName
    FROM dbo.Enrollments e JOIN dbo.Students st ON st.StudentId=e.StudentId JOIN dbo.Users u ON u.UserId=st.ParentUserId
    JOIN dbo.Sessions s ON s.SessionId=e.SessionId LEFT JOIN dbo.ArtTypes a ON a.ArtTypeId=e.ArtTypeId JOIN dbo.Plans p ON p.PlanId=e.PlanId
    ORDER BY e.EnrolledAt DESC`);
  return { jsonBody: r.recordset };
}) });


app.http('adminSessionCreate', { methods: ['POST'], route: 'manage/sessions', authLevel: 'anonymous', handler: handler(async req => {
  requireAdmin(req);
  const b = await req.json();
  const day = Number(b.dayOfWeek), cap = Number(b.capacity || 8);
  if (!(day >= 1 && day <= 6) || !/^\d\d:\d\d$/.test(b.start) || !/^\d\d:\d\d$/.test(b.end) || b.end <= b.start || !(cap >= 1 && cap <= 50)) throw fail(400, 'Invalid session (Sunday is closed)');
  try {
    const r = await (await getPool()).request().input('d', sql.TinyInt, day).input('s', sql.VarChar(5), b.start).input('e', sql.VarChar(5), b.end)
      .input('a', sql.NVarChar(40), clean(b.ageGroup || 'All ages', 40)).input('c', sql.TinyInt, cap)
      .query('INSERT dbo.Sessions (DayOfWeek, StartTime, EndTime, AgeGroup, Capacity) OUTPUT INSERTED.SessionId VALUES (@d, CAST(@s AS TIME(0)), CAST(@e AS TIME(0)), @a, @c)');
    return { status: 201, jsonBody: { ok: true, sessionId: r.recordset[0].SessionId } };
  } catch (e) {
    if (e.number === 2627 || e.number === 2601) {            // slot exists: bring it back if it was disabled
      const u = await (await getPool()).request().input('d', sql.TinyInt, day).input('s', sql.VarChar(5), b.start).input('e', sql.VarChar(5), b.end).input('a', sql.NVarChar(40), clean(b.ageGroup || 'All ages', 40)).input('c', sql.TinyInt, cap)
        .query('UPDATE dbo.Sessions SET IsActive=1, EndTime=CAST(@e AS TIME(0)), AgeGroup=@a, Capacity=@c WHERE DayOfWeek=@d AND StartTime=CAST(@s AS TIME(0)) AND IsActive=0');
      if (u.rowsAffected[0]) return { status: 201, jsonBody: { ok: true } };
      throw fail(409, 'A session already starts at that time');
    }
    throw e;
  }
}) });

app.http('adminSessionDelete', { methods: ['DELETE'], route: 'manage/sessions/{id}', authLevel: 'anonymous', handler: handler(async req => {
  requireAdmin(req);
  const id = Number(req.params.id), rq = (await getPool()).request().input('id', sql.Int, id);
  if (req.query.get('hard') === '1') {          // real delete: only possible when the slot never had bookings
    try { await rq.query('DELETE dbo.Sessions WHERE SessionId=@id'); }
    catch (e) { if (e.number === 547) throw fail(409, 'This slot has bookings or requests, so it cannot be deleted. Disable it instead.'); throw e; }
  } else await rq.query('UPDATE dbo.Sessions SET IsActive=0 WHERE SessionId=@id'); // soft delete keeps enrollment history
  return { jsonBody: { ok: true } };
}) });

app.http('adminPayments', { methods: ['GET'], route: 'manage/payments', authLevel: 'anonymous', handler: handler(async req => {
  requireAdmin(req);
  const r = await (await getPool()).request().query(`SELECT TOP 500 p.PaymentId, p.PayerName, p.PayerEmail, p.PaymentType, p.Description, p.Amount, p.Method, p.Status, p.CreatedAt, p.PaidAt, st.FullName AS Student
     FROM dbo.Payments p LEFT JOIN dbo.Enrollments e ON e.EnrollmentId=p.EnrollmentId LEFT JOIN dbo.Students st ON st.StudentId=e.StudentId ORDER BY p.CreatedAt DESC`);
  return { jsonBody: r.recordset };
}) });

