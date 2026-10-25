const { app } = require('@azure/functions');
const { sql, getPool, fail, handler } = require('../db');
const { sendMail, requireAdmin } = require('../auth');
const clean = (v, m) => String(v ?? '').trim().slice(0, m);
const GUID = /^[0-9a-fA-F-]{36}$/;
const imgUrl = id => (id && GUID.test(id) ? `/api/images/${id}` : null);
const r = (name, method, route, fn) => app.http(name, { methods: [method], route, authLevel: 'anonymous', handler: handler(async (req, ctx) => {
    requireAdmin(req);
    try { return await fn(req, ctx); }
    catch (e) { if (e.status) throw e; ctx.error(e); throw fail(500, 'Database error: ' + ((e.originalError && e.originalError.message) || e.message)); } // admin-only, so the detail is safe to show
  }) });
const ok = { jsonBody: { ok: true } };

// ----- enrollments: accept / decline / change time -----
r('adminEnrollmentUpdate', 'PATCH', 'manage/enrollments/{id}', async req => {
  const b = await req.json(), id = Number(req.params.id);
  const status = b.status ? String(b.status) : null, sessionId = b.sessionId ? Number(b.sessionId) : null;
  if (status && !['Pending', 'Active', 'Paused', 'Cancelled', 'Declined'].includes(status)) throw fail(400, 'Bad status');
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  const q = () => new sql.Request(tx);
  let mail = null;
  try {
    const e = (await q().input('id', sql.Int, id).query(
      `SELECT e.EnrollmentId, e.SessionId, e.Status, e.PlanId, st.FullName, st.ParentUserId, u.Email, u.FirstName
       FROM dbo.Enrollments e WITH (UPDLOCK) JOIN dbo.Students st ON st.StudentId=e.StudentId JOIN dbo.Users u ON u.UserId=st.ParentUserId WHERE e.EnrollmentId=@id`)).recordset[0];
    if (!e) throw fail(404, 'Not found');
    if (sessionId && sessionId !== e.SessionId) {
      const s = (await q().input('s', sql.Int, sessionId).query('SELECT Capacity FROM dbo.Sessions WITH (UPDLOCK, HOLDLOCK) WHERE SessionId=@s AND IsActive=1')).recordset[0];
      if (!s) throw fail(404, 'Session not found');
      const n = (await q().input('s', sql.Int, sessionId).input('id', sql.Int, id)
        .query("SELECT COUNT(*) AS n FROM dbo.Enrollments WHERE SessionId=@s AND EnrollmentId<>@id AND Status IN ('Pending','Active')")).recordset[0].n;
      if (n >= s.Capacity) throw fail(409, 'That session is full');
      await q().input('s', sql.Int, sessionId).input('id', sql.Int, id).query('UPDATE dbo.Enrollments SET SessionId=@s WHERE EnrollmentId=@id');
    }
    if (status && status !== e.Status) {
      await q().input('st', sql.NVarChar(20), status).input('id', sql.Int, id).query('UPDATE dbo.Enrollments SET Status=@st WHERE EnrollmentId=@id');
      if (status === 'Active') {                       // ACCEPT: enable the parent login and bill the first fees
        await q().input('u', sql.Int, e.ParentUserId).query('UPDATE dbo.Users SET IsActive=1 WHERE UserId=@u');
        const has = (await q().input('id', sql.Int, id).query('SELECT COUNT(*) AS n FROM dbo.Payments WHERE EnrollmentId=@id')).recordset[0].n;
        if (!has) {
          const p = (await q().input('p', sql.SmallInt, e.PlanId).query('SELECT Name, Price FROM dbo.Plans WHERE PlanId=@p')).recordset[0];
          await q().input('u', sql.Int, e.ParentUserId).input('n', sql.NVarChar(120), e.FirstName).input('e', sql.NVarChar(256), e.Email).input('en', sql.Int, id)
            .input('d', sql.NVarChar(200), p.Name).input('am', sql.Decimal(10, 2), Number(p.Price))
            .query("INSERT dbo.Payments (UserId, PayerName, PayerEmail, PaymentType, EnrollmentId, Description, Amount, Method) VALUES (@u,@n,@e,'Fees',@en,@d,@am,'Zelle')");
        }
        mail = [e.Email, 'Your Dream Arts enrollment is confirmed', `Hi ${e.FirstName},\n\nGood news! The class time for ${e.FullName} has been approved. You can now log in with this email address on the Dream Arts website to see the schedule and the payment details.\n\n- Dream Arts`];
      } else if (status === 'Declined') {
        mail = [e.Email, 'Update on your Dream Arts enrollment', `Hi ${e.FirstName},\n\nWe could not confirm the requested class time for ${e.FullName}. Please reply to this email or register again and choose another session.\n\n- Dream Arts`];
      }
    }
    await tx.commit();
  } catch (err) { await tx.rollback().catch(() => {}); throw err; }
  if (mail) { try { await sendMail(...mail); } catch (e) { /* approval stays saved even if the email fails */ } }
  return ok;
});

// ----- payments -----
r('adminPaymentUpdate', 'PATCH', 'manage/payments/{id}', async req => {
  const b = await req.json();
  if (!['Pending', 'Submitted', 'Paid', 'Failed', 'Refunded'].includes(b.status)) throw fail(400, 'Bad status');
  await (await getPool()).request().input('id', sql.Int, Number(req.params.id)).input('s', sql.NVarChar(20), b.status).query(
    `UPDATE dbo.Payments SET Status=@s, PaidAt=CASE WHEN @s='Paid' THEN SYSUTCDATETIME() ELSE PaidAt END WHERE PaymentId=@id;
     UPDATE p SET p.Status = CASE WHEN @s='Paid' THEN 'Sold' ELSE 'Available' END
     FROM dbo.Paintings p JOIN dbo.Payments y ON y.PaintingId=p.PaintingId
     WHERE y.PaymentId=@id AND @s IN ('Paid','Failed','Refunded');
     UPDATE p SET p.Status='Reserved' FROM dbo.Paintings p JOIN dbo.Payments y ON y.PaintingId=p.PaintingId
     WHERE y.PaymentId=@id AND @s='Pending' AND p.Status='Available'`);
  return ok;
});

// ----- parent requests -----
r('adminRequests', 'GET', 'manage/requests', async () => {
  const x = await (await getPool()).request().query(
    `SELECT c.RequestId, c.RequestType, c.Status, c.Message, c.AdminNote, c.CreatedAt, c.EnrollmentId, c.PreferredSessionId, CONVERT(VARCHAR(10),c.ClassDate,23) AS ClassDate,
            u.FirstName AS Parent, u.Email, st.FullName AS Student, ps.DayOfWeek AS PDay, CONVERT(VARCHAR(5),ps.StartTime,108) AS PStart
     FROM dbo.ChangeRequests c JOIN dbo.Users u ON u.UserId=c.UserId
     LEFT JOIN dbo.Enrollments e ON e.EnrollmentId=c.EnrollmentId LEFT JOIN dbo.Students st ON st.StudentId=e.StudentId
     LEFT JOIN dbo.Sessions ps ON ps.SessionId=c.PreferredSessionId ORDER BY c.CreatedAt DESC`);
  return { jsonBody: x.recordset };
});
r('adminRequestUpdate', 'PATCH', 'manage/requests/{id}', async req => {
  const b = await req.json(), id = Number(req.params.id);
  if (!['Pending', 'Approved', 'Declined'].includes(b.status)) throw fail(400, 'Bad status');
  const note = clean(b.adminNote, 500), offered = Number(b.sessionId) || null;
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  const q = () => new sql.Request(tx);
  let row, newTime = null;
  try {
    row = (await q().input('id', sql.Int, id).query(
      `SELECT c.RequestType, c.EnrollmentId, c.PreferredSessionId, u.Email, u.FirstName FROM dbo.ChangeRequests c JOIN dbo.Users u ON u.UserId=c.UserId WHERE c.RequestId=@id`)).recordset[0];
    if (!row) throw fail(404, 'Not found');
    const target = b.status === 'Approved' ? (offered || row.PreferredSessionId) : null;
    if (target) {
      const s2 = (await q().input('s', sql.Int, target).query("SELECT DayOfWeek, CONVERT(VARCHAR(5),StartTime,108) AS st, CONVERT(VARCHAR(5),EndTime,108) AS en, Capacity FROM dbo.Sessions WITH (UPDLOCK, HOLDLOCK) WHERE SessionId=@s AND IsActive=1")).recordset[0];
      if (!s2) throw fail(404, 'That session is not available');
      newTime = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s2.DayOfWeek - 1] + ' ' + s2.st + '-' + s2.en;
      if (row.RequestType === 'ScheduleChange' && row.EnrollmentId) {      // approving a schedule change moves the student
        const n = (await q().input('s', sql.Int, target).input('e', sql.Int, row.EnrollmentId)
          .query("SELECT COUNT(*) AS n FROM dbo.Enrollments WHERE SessionId=@s AND EnrollmentId<>@e AND Status IN ('Pending','Active')")).recordset[0].n;
        if (n >= s2.Capacity) throw fail(409, 'That session is full');
        await q().input('s', sql.Int, target).input('e', sql.Int, row.EnrollmentId).query('UPDATE dbo.Enrollments SET SessionId=@s WHERE EnrollmentId=@e');
      }
    }
    await q().input('id', sql.Int, id).input('s', sql.NVarChar(20), b.status).input('n', sql.NVarChar(500), note)
      .query('UPDATE dbo.ChangeRequests SET Status=@s, AdminNote=@n, ResolvedAt=SYSUTCDATETIME() WHERE RequestId=@id');
    await tx.commit();
  } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  if (b.status !== 'Pending') {
    const what = b.status === 'Approved' ? (newTime ? `approved. The time is: ${newTime}` : 'approved') : 'declined';
    try { await sendMail(row.Email, 'Update on your Dream Arts request', `Hi ${row.FirstName},\n\nYour request has been ${what}.${note ? '\n\nNote from the teacher: ' + note : ''}\n\nYou can see the details under My account on the Dream Arts website.\n\n- Dream Arts`); } catch (e) { /* the decision stays saved even if the email fails */ }
  }
  return ok;
});

// ----- schedule: list everything (incl. disabled), enable/disable, seats -----
r('adminSessions', 'GET', 'manage/sessions', async () => {
  const x = await (await getPool()).request().query(
    `SELECT s.SessionId, s.DayOfWeek, CONVERT(VARCHAR(5),s.StartTime,108) AS StartTime, CONVERT(VARCHAR(5),s.EndTime,108) AS EndTime, s.AgeGroup, s.Capacity, s.IsActive,
            (SELECT COUNT(*) FROM dbo.Enrollments e WHERE e.SessionId=s.SessionId AND e.Status IN ('Pending','Active')) AS Enrolled
     FROM dbo.Sessions s ORDER BY s.DayOfWeek, s.StartTime`);
  return { jsonBody: x.recordset };
});
r('adminSessionUpdate', 'PATCH', 'manage/sessions/{id}', async req => {
  const b = await req.json(), rq = (await getPool()).request().input('id', sql.Int, Number(req.params.id)), sets = [];
  if (b.isActive !== undefined) { rq.input('a', sql.Bit, b.isActive ? 1 : 0); sets.push('IsActive=@a'); }
  if (b.capacity !== undefined) { const c = Number(b.capacity); if (!(c >= 1 && c <= 50)) throw fail(400, 'Seats must be 1-50'); rq.input('c', sql.TinyInt, c); sets.push('Capacity=@c'); }
  if (!sets.length) throw fail(400, 'Nothing to update');
  await rq.query(`UPDATE dbo.Sessions SET ${sets.join(', ')} WHERE SessionId=@id`);
  return ok;
});

// ----- fees -----
r('adminPlanUpdate', 'PATCH', 'manage/plans/{id}', async req => {
  const b = await req.json(), rq = (await getPool()).request().input('id', sql.SmallInt, Number(req.params.id)), sets = [];
  if (b.price !== undefined) { if (!(Number(b.price) >= 0)) throw fail(400, 'Bad price'); rq.input('p', sql.Decimal(10, 2), Number(b.price)); sets.push('Price=@p'); }
  if (b.name !== undefined) { if (!clean(b.name, 60)) throw fail(400, 'Bad name'); rq.input('n', sql.NVarChar(60), clean(b.name, 60)); sets.push('Name=@n'); }
  if (b.description !== undefined) { rq.input('d', sql.NVarChar(200), clean(b.description, 200)); sets.push('Description=@d'); }
  if (!sets.length) throw fail(400, 'Nothing to update');
  await rq.query(`UPDATE dbo.Plans SET ${sets.join(', ')} WHERE PlanId=@id`);
  return ok;
});

// ----- students (to tie a picture to a student) -----
r('adminStudents', 'GET', 'manage/students', async () => {
  const x = await (await getPool()).request().query(
    `SELECT st.StudentId, st.FullName, st.Age, u.Email AS ParentEmail FROM dbo.Students st JOIN dbo.Users u ON u.UserId=st.ParentUserId ORDER BY st.FullName`);
  return { jsonBody: x.recordset };
});

// ----- paintings for sale -----
r('adminPaintingCreate', 'POST', 'manage/paintings', async req => {
  const b = await req.json();
  const title = clean(b.title, 150), price = Number(b.price);
  if (!title || !(price >= 0) || !Number(b.artTypeId)) throw fail(400, 'Title, art type and price are required');
  const x = await (await getPool()).request().input('t', sql.NVarChar(150), title).input('a', sql.NVarChar(120), clean(b.artist || 'Dream Arts', 120))
    .input('at', sql.SmallInt, Number(b.artTypeId)).input('sz', sql.NVarChar(40), clean(b.size, 40)).input('p', sql.Decimal(10, 2), price).input('i', sql.NVarChar(500), imgUrl(b.imageId))
    .query('INSERT dbo.Paintings (Title, ArtistName, ArtTypeId, SizeText, Price, ImageUrl) OUTPUT INSERTED.PaintingId VALUES (@t,@a,@at,@sz,@p,@i)');
  return { status: 201, jsonBody: { ok: true, paintingId: x.recordset[0].PaintingId } };
});
r('adminPaintingUpdate', 'PATCH', 'manage/paintings/{id}', async req => {
  const b = await req.json();
  const rq = (await getPool()).request().input('id', sql.Int, Number(req.params.id));
  const sets = [];
  if (b.price !== undefined) { if (!(Number(b.price) >= 0)) throw fail(400, 'Bad price'); rq.input('p', sql.Decimal(10, 2), Number(b.price)); sets.push('Price=@p'); }
  if (b.status !== undefined) { if (!['Available', 'Reserved', 'Sold'].includes(b.status)) throw fail(400, 'Bad status'); rq.input('s', sql.NVarChar(20), b.status); sets.push('Status=@s'); }
  if (!sets.length) throw fail(400, 'Nothing to update');
  await rq.query(`UPDATE dbo.Paintings SET ${sets.join(', ')} WHERE PaintingId=@id`);
  return ok;
});
r('adminPaintingDelete', 'DELETE', 'manage/paintings/{id}', async req => {
  try { await (await getPool()).request().input('id', sql.Int, Number(req.params.id)).query('DELETE dbo.Paintings WHERE PaintingId=@id'); }
  catch (e) { if (e.number === 547) throw fail(409, 'This painting has orders. Mark it Sold instead of deleting.'); throw e; }
  return ok;
});

// ----- student gallery -----
r('adminArtworkCreate', 'POST', 'manage/artworks', async req => {
  const b = await req.json(), pool = await getPool(), studentId = Number(b.studentId) || null;
  let artist = clean(b.artist, 120);
  if (studentId) {
    const st = (await pool.request().input('s', sql.Int, studentId).query('SELECT FullName, Age FROM dbo.Students WHERE StudentId=@s')).recordset[0];
    if (!st) throw fail(400, 'Student not found');
    if (!artist) artist = `${st.FullName}, ${st.Age}`;
  }
  if (!clean(b.title, 150) || !artist || !Number(b.artTypeId)) throw fail(400, 'Title, student (or artist) and art type are required');
  const x = await pool.request().input('t', sql.NVarChar(150), clean(b.title, 150)).input('a', sql.NVarChar(120), artist).input('st', sql.Int, studentId)
    .input('at', sql.SmallInt, Number(b.artTypeId)).input('i', sql.NVarChar(500), imgUrl(b.imageId))
    .query('INSERT dbo.StudentArtworks (StudentId, Title, ArtistName, ArtTypeId, ImageUrl) OUTPUT INSERTED.ArtworkId VALUES (@st,@t,@a,@at,@i)');
  return { status: 201, jsonBody: { ok: true, artworkId: x.recordset[0].ArtworkId } };
});
r('adminArtworkDelete', 'DELETE', 'manage/artworks/{id}', async req => {
  await (await getPool()).request().input('id', sql.Int, Number(req.params.id)).query('DELETE dbo.StudentArtworks WHERE ArtworkId=@id');
  return ok;
});

// ----- custom painting requests -----
r('adminCustomRequests', 'GET', 'manage/custom-requests', async () => {
  const x = await (await getPool()).request().query(
    `SELECT c.RequestId, c.Name, c.Email, c.Phone, a.Name AS ArtType, c.SizeText, c.Budget, c.Details, c.ReferenceImageUrl, c.QuotedPrice, c.Status, c.CreatedAt
     FROM dbo.CustomRequests c LEFT JOIN dbo.ArtTypes a ON a.ArtTypeId=c.ArtTypeId ORDER BY c.CreatedAt DESC`);
  return { jsonBody: x.recordset };
});
r('adminCustomRequestUpdate', 'PATCH', 'manage/custom-requests/{id}', async req => {
  const b = await req.json();
  if (!['New', 'Quoted', 'In progress', 'Completed', 'Declined'].includes(b.status)) throw fail(400, 'Bad status');
  const rq = (await getPool()).request().input('id', sql.Int, Number(req.params.id)).input('s', sql.NVarChar(20), b.status);
  let extra = '';
  if (b.quotedPrice !== undefined && b.quotedPrice !== null && b.quotedPrice !== '') { rq.input('q', sql.Decimal(10, 2), Number(b.quotedPrice)); extra = ', QuotedPrice=@q'; }
  await rq.query(`UPDATE dbo.CustomRequests SET Status=@s${extra} WHERE RequestId=@id`);
  return ok;
});

// ----- settings (Zelle phone + QR image) -----
r('adminSettingsGet', 'GET', 'manage/settings', async () => {
  const x = await (await getPool()).request().query('SELECT SettingKey, SettingValue FROM dbo.Settings');
  return { jsonBody: Object.fromEntries(x.recordset.map(v => [v.SettingKey, v.SettingValue])) };
});
r('adminSettingsPut', 'PUT', 'manage/settings', async req => {
  const b = await req.json(), pool = await getPool();
  const items = [];
  if (b.zellePhone !== undefined) items.push(['zellePhone', clean(b.zellePhone, 30)]);
  if (b.zelleQrImageId !== undefined) { if (b.zelleQrImageId && !GUID.test(b.zelleQrImageId)) throw fail(400, 'Bad image'); items.push(['zelleQrImageId', clean(b.zelleQrImageId, 40)]); }
  for (const [k, v] of items) await pool.request().input('k', sql.NVarChar(50), k).input('v', sql.NVarChar(500), v)
    .query('MERGE dbo.Settings AS t USING (SELECT @k AS k) AS s ON t.SettingKey=s.k WHEN MATCHED THEN UPDATE SET SettingValue=@v WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@k,@v);');
  return ok;
});
