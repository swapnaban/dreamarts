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
