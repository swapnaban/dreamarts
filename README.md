# Dream Arts on Azure (Static Web App + Azure SQL)

web/   the website (index.html) + staticwebapp.config.json
api/   Azure Functions (Node 18+/20) that talk to Azure SQL

## What works through Azure SQL in this package
* Schedule: GET /api/sessions (live seats left), admin add/delete of class slots (Mon-Sat, Sunday blocked)
* Enrollments: POST /api/register creates parent user (role User) + student + enrollment + pending payment in ONE transaction,
  and refuses a full session (capacity enforced on the server)
* Admin: list/update enrollments, list payments, mark paid
Gallery, paintings for sale and custom requests still use the earlier preview database; their tables already exist in SQL for the next phase.

## Deploy (about 15 minutes)
1. Run dreamarts_schema.sql in the Azure portal Query editor (database dreamarts) if you have not yet.
2. Create an Azure SQL login/user for the app with least privilege, NOT the server admin:
   CREATE USER [dreamarts_app] WITH PASSWORD = '<strong password>';
   ALTER ROLE db_datareader ADD MEMBER [dreamarts_app]; ALTER ROLE db_datawriter ADD MEMBER [dreamarts_app];
   (A passwordless Managed Identity is even better once the app is running.)
3. SQL server > Networking: turn on "Allow Azure services and resources to access this server".
4. Push this folder to a GitHub repo. In the portal create a Static Web App (Free plan), point it at the repo with
   App location = web, Api location = api, no build step.
5. Static Web App > Environment variables, add:  SQL_CONNECTION_STRING = Server=tcp:dreamarts.database.windows.net,1433;Database=dreamarts;User ID=dreamarts_app;Password=...;Encrypt=true;
6. Make yourself admin: Static Web App > Role management > Invite, provider Microsoft, role "admin".
   Then open https://<your-site>/.auth/login/aad once; the Admin menu appears for you only.
7. Test: register a student; check dbo.Enrollments and dbo.Payments in the Query editor.

Never commit the connection string. local.settings.json.sample shows the local-dev format.

## Parent login (email one-time code)
New files: dreamarts_auth.sql, api/src/auth.js, api/src/functions/auth.js. Parents get a "Login" menu item and a "My account" page.

1. Run dreamarts_auth.sql in the Azure Query editor (adds LoginCodes, AuthSessions and Users.EmailVerifiedAt).
2. Create the email sender: portal > "Communication Services" > create one, then "Email" > create an Email Communication Service
   with an Azure-managed domain (free, gives you DoNotReply@xxxx.azurecomm.net), and connect that domain to the Communication Service.
3. Static Web App > Environment variables, add:
   AUTH_SECRET            = a long random string (32+ characters, make one up; keep it secret)
   ACS_CONNECTION_STRING  = Communication Service > Keys > connection string
   EMAIL_SENDER           = the DoNotReply@... address from step 2
4. Push to GitHub (the deployment runs by itself).
Rules: only emails already registered can log in; codes last 10 minutes, max 5 tries, max 5 codes per email per hour;
a session lasts 7 days; an email that already has an account must log in before registering another child.

## Version 2 (approval workflow, Zelle, requests, uploads, FAQ chat)
1. Run dreamarts_v2.sql in the Azure Query editor (run each numbered block separately if the editor complains). It adds the
   Pending/Declined enrollment statuses, the Submitted payment status, and the tables Images, Settings and ChangeRequests.
2. Replace the repo files with this zip and push. No new environment variables are needed.
3. Sign in as admin (/.auth/login/aad) > Admin page:
   * "Zelle payment settings": type your Zelle phone number and upload the QR image from your bank app (Zelle > Receive/QR code).
   * "Upload painting for sale" / "Upload to student gallery": pick a photo; it is shrunk in the browser (about 1400 px) and stored in the database.
How it works now
* A new registration is "Pending" and holds a seat. The parent account stays DISABLED, so no login code is sent.
* Admin > "Waiting for approval": pick/confirm the time and click "Accept & enable login". That activates the enrollment and the parent
  login, creates the first payment (plan + $20 registration fee for the first child), and emails the parent. "Decline" emails them too.
* Parents (My account) see only their own schedule, payments, requests; they can pay by Zelle (QR + phone + reference DA-<id>),
  press "I have sent the payment", and request a schedule change / additional class / missed-class make-up.
* Visitors can buy a painting without an account: it is Reserved, they get the Zelle instructions, and Admin > Payments "Mark paid" sets it Sold.
  "Failed / release" puts it back on sale.
* The chat bubble answers common questions from a built-in list (no paid AI service).
Troubleshooting: open /api/health (shows which settings exist and the database error code, never secrets). Azure SQL free
databases pause when idle: the first request after a quiet period can fail while it wakes (about a minute). Delete health.js when done.
