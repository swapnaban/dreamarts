/* Dream Arts - parent login (email one-time code). Run once in the Azure Query editor. */
ALTER TABLE dbo.Users ADD EmailVerifiedAt DATETIME2 NULL;
GO
CREATE TABLE dbo.LoginCodes (
    CodeId    INT IDENTITY(1,1) PRIMARY KEY,
    Email     NVARCHAR(256) NOT NULL,
    CodeHash  CHAR(64)      NOT NULL,          -- HMAC of the code, never the code itself
    Attempts  TINYINT       NOT NULL DEFAULT 0,
    ExpiresAt DATETIME2     NOT NULL,
    UsedAt    DATETIME2     NULL,
    CreatedAt DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_LoginCodes_Email ON dbo.LoginCodes (Email, CreatedAt DESC);

CREATE TABLE dbo.AuthSessions (
    TokenHash CHAR(64)  NOT NULL PRIMARY KEY,  -- HMAC of the session token
    UserId    INT       NOT NULL REFERENCES dbo.Users(UserId),
    ExpiresAt DATETIME2 NOT NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_AuthSessions_User ON dbo.AuthSessions (UserId);
GO
