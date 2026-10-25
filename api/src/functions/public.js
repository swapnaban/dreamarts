const { app } = require('@azure/functions');
const { sql, getPool, fail, handler } = require('../db');
const { userFromToken, isAdmin } = require('../auth');
const clean = (v, m) => String(v ?? '').trim().slice(0, m);
const GUID = /^[0-9a-fA-F-]{36}$/;
const email = v => { v = clean(v, 256).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw fail(400, 'Invalid email'); return v; };
const pub = (name, method, route, fn) => app.http(name, { methods: [method], route, authLevel: 'anonymous', handler: handler(fn) });

async function zelle(pool) {
  const x = await pool.request().query("SELECT SettingKey, SettingValue FROM dbo.Settings WHERE SettingKey IN ('zellePhone','zelleQrImageId')");
  const m = Object.fromEntries(x.recordset.map(v => [v.SettingKey, v.SettingValue]));
  return { phone: m.zellePhone || '', qrImageId: m.zelleQrImageId || '' };
}

pub('paintings', 'GET', 'paintings', async () => {
  const x = await (await getPool()).request().query(
    `SELECT p.PaintingId, p.Title, p.ArtistName, a.Name AS ArtType, p.SizeText, p.Price, p.ImageUrl, p.Status
     FROM dbo.Paintings p JOIN dbo.ArtTypes a ON a.ArtTypeId=p.ArtTypeId ORDER BY p.CreatedAt DESC`);
  return { jsonBody: x.recordset };
});
pub('artworks', 'GET', 'artworks', async req => {
  if (!isAdmin(req) && !(await userFromToken(req))) throw fail(401, 'Please log in');   // student gallery: logged-in families and admin only
  const x = await (await getPool()).request().query(
    `SELECT w.ArtworkId, w.Title, w.ArtistName, a.Name AS ArtType, w.ImageUrl FROM dbo.StudentArtworks w JOIN dbo.ArtTypes a ON a.ArtTypeId=w.ArtTypeId
     WHERE w.IsPublished=1 ORDER BY w.CreatedAt DESC`);
  return { jsonBody: x.recordset };
});

// Buy a painting: reserve it and return the Zelle instructions
pub('purchase', 'POST', 'purchase', async req => {
  const b = await req.json();
  const name = clean(b.name, 120), mail = email(b.email), paintingId = Number(b.paintingId);
  if (!name || !paintingId) throw fail(400, 'Name and painting are required');
  const pool = await getPool(), tx = new sql.Transaction(pool);
  await tx.begin();
  const q = () => new sql.Request(tx);
  try {
    const p = (await q().input('id', sql.Int, paintingId).query("SELECT Title, Price, Status FROM dbo.Paintings WITH (UPDLOCK, HOLDLOCK) WHERE PaintingId=@id")).recordset[0];
    if (!p) throw fail(404, 'Painting not found');
    if (p.Status !== 'Available') throw fail(409, 'sold');
    await q().input('id', sql.Int, paintingId).query("UPDATE dbo.Paintings SET Status='Reserved' WHERE PaintingId=@id");
    const me = await userFromToken(req);
    const pay = await q().input('u', sql.Int, me ? me.UserId : null).input('n', sql.NVarChar(120), name).input('e', sql.NVarChar(256), mail).input('pid', sql.Int, paintingId)
      .input('d', sql.NVarChar(200), `Painting: ${p.Title}`).input('am', sql.Decimal(10, 2), p.Price)
      .query("INSERT dbo.Payments (UserId, PayerName, PayerEmail, PaymentType, PaintingId, Description, Amount, Method) OUTPUT INSERTED.PaymentId VALUES (@u,@n,@e,'Painting',@pid,@d,@am,'Zelle')");
    await tx.commit();
    const id = pay.recordset[0].PaymentId;
    return { status: 201, jsonBody: { ok: true, paymentId: id, reference: `DA-${id}`, amount: Number(p.Price), title: p.Title, zelle: await zelle(pool) } };
  } catch (e) { await tx.rollback().catch(() => {}); throw e; }
});

pub('customRequest', 'POST', 'custom-requests', async req => {
  const b = await req.json();
  const details = clean(b.details, 2000);
  if (!clean(b.name, 120) || !details) throw fail(400, 'Name and details are required');
  const ref = b.imageId && GUID.test(b.imageId) ? `/api/images/${b.imageId}` : null;
  const me = await userFromToken(req);
  await (await getPool()).request().input('u', sql.Int, me ? me.UserId : null).input('n', sql.NVarChar(120), clean(b.name, 120)).input('e', sql.NVarChar(256), email(b.email))
    .input('ph', sql.NVarChar(30), clean(b.phone, 30)).input('at', sql.SmallInt, Number(b.artTypeId) || null).input('sz', sql.NVarChar(40), clean(b.size, 40))
    .input('bu', sql.Decimal(10, 2), Number(b.budget) || null).input('d', sql.NVarChar(2000), details).input('r', sql.NVarChar(500), ref)
    .query('INSERT dbo.CustomRequests (UserId, Name, Email, Phone, ArtTypeId, SizeText, Budget, Details, ReferenceImageUrl) VALUES (@u,@n,@e,@ph,@at,@sz,@bu,@d,@r)');
  return { status: 201, jsonBody: { ok: true } };
});

// ----- images: stored in the database (small JPEGs), served with long caching -----
pub('imageGet', 'GET', 'images/{id}', async req => {
  const id = req.params.id;
  if (!GUID.test(id)) throw fail(404, 'Not found');
  const x = await (await getPool()).request().input('id', sql.UniqueIdentifier, id).query('SELECT ContentType, Data FROM dbo.Images WHERE ImageId=@id');
  if (!x.recordset.length) throw fail(404, 'Not found');
  return { status: 200, headers: { 'Content-Type': x.recordset[0].ContentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }, body: x.recordset[0].Data };
});
pub('imageUpload', 'POST', 'images', async req => {
  if (!isAdmin(req) && !(await userFromToken(req))) throw fail(401, 'Please log in');   // admins and logged-in parents only
  const b = await req.json();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(b.contentType)) throw fail(400, 'Only JPEG, PNG or WebP images');
  const data = Buffer.from(String(b.data || ''), 'base64');
  if (!data.length || data.length > 1.5 * 1024 * 1024) throw fail(400, 'Image must be under 1.5 MB');
  const x = await (await getPool()).request().input('c', sql.NVarChar(50), b.contentType).input('d', sql.VarBinary(sql.MAX), data)
    .query('INSERT dbo.Images (ContentType, Data) OUTPUT INSERTED.ImageId VALUES (@c, @d)');
  return { status: 201, jsonBody: { ok: true, imageId: x.recordset[0].ImageId } };
});
