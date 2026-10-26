/* =====================================================================
   Dream Arts - Azure SQL Database schema (T-SQL)
   Server: dreamarts.database.windows.net   Database: dreamarts
   Run in the Azure portal Query editor, or SSMS / Azure Data Studio.
   Safe to run once on an empty database.
   ===================================================================== */

/* ---------- 1. Users and roles ---------- */
CREATE TABLE dbo.Roles (
    RoleId     TINYINT      NOT NULL PRIMARY KEY,
    RoleName   NVARCHAR(30) NOT NULL UNIQUE          -- Admin, User
);

CREATE TABLE dbo.Users (
    UserId        INT IDENTITY(1,1) PRIMARY KEY,
    RoleId        TINYINT       NOT NULL REFERENCES dbo.Roles(RoleId),
    Email         NVARCHAR(256) NOT NULL UNIQUE,
    PasswordHash  NVARCHAR(255) NULL,                -- hash only (bcrypt/Argon2 from the API). NULL if you use Microsoft Entra / social login.
    FirstName     NVARCHAR(80)  NOT NULL,
    LastName      NVARCHAR(80)  NULL,
    Phone         NVARCHAR(30)  NULL,
    IsActive      BIT           NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    LastLoginAt   DATETIME2     NULL
);

/* ---------- 2. Students (children belong to a parent User) ---------- */
CREATE TABLE dbo.Students (
    StudentId     INT IDENTITY(1,1) PRIMARY KEY,
    ParentUserId  INT           NOT NULL REFERENCES dbo.Users(UserId),
    FullName      NVARCHAR(120) NOT NULL,
    Age           TINYINT       NOT NULL CHECK (Age BETWEEN 3 AND 18),
    Level         NVARCHAR(30)  NOT NULL DEFAULT 'Beginner',  -- Beginner / Some experience / Advanced
    Notes         NVARCHAR(1000) NULL,
    CreatedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Students_Parent ON dbo.Students(ParentUserId);

/* ---------- 3. Catalog: art types, plans, weekly sessions ---------- */
CREATE TABLE dbo.ArtTypes (
    ArtTypeId    SMALLINT IDENTITY(1,1) PRIMARY KEY,
    Name         NVARCHAR(60)  NOT NULL UNIQUE,
    Description  NVARCHAR(300) NULL,
    IsActive     BIT NOT NULL DEFAULT 1
);

CREATE TABLE dbo.Plans (
    PlanId       SMALLINT IDENTITY(1,1) PRIMARY KEY,
    Name         NVARCHAR(60)  NOT NULL UNIQUE,
    Price        DECIMAL(10,2) NOT NULL CHECK (Price >= 0),
    Description  NVARCHAR(200) NULL,
    ClassCount   SMALLINT NULL,
    IsActive     BIT NOT NULL DEFAULT 1
);

CREATE TABLE dbo.Sessions (                      -- the weekly timetable
    SessionId    INT IDENTITY(1,1) PRIMARY KEY,
    DayOfWeek    TINYINT NOT NULL CHECK (DayOfWeek BETWEEN 1 AND 6),   -- 1=Mon ... 6=Sat (Sunday closed)
    StartTime    TIME(0) NOT NULL,
    EndTime      TIME(0) NOT NULL,
    AgeGroup     NVARCHAR(40) NOT NULL DEFAULT 'All ages',
    Capacity     TINYINT NOT NULL DEFAULT 8,
    IsActive     BIT NOT NULL DEFAULT 1,
    CONSTRAINT CK_Sessions_Time CHECK (EndTime > StartTime),
    CONSTRAINT UQ_Sessions UNIQUE (DayOfWeek, StartTime)
);

/* ---------- 4. Enrollments ---------- */
CREATE TABLE dbo.Enrollments (
    EnrollmentId INT IDENTITY(1,1) PRIMARY KEY,
    StudentId    INT      NOT NULL REFERENCES dbo.Students(StudentId),
    SessionId    INT      NOT NULL REFERENCES dbo.Sessions(SessionId),
    ArtTypeId    SMALLINT NOT NULL REFERENCES dbo.ArtTypes(ArtTypeId),
    PlanId       SMALLINT NOT NULL REFERENCES dbo.Plans(PlanId),
    Status       NVARCHAR(20) NOT NULL DEFAULT 'Active'
                 CHECK (Status IN ('Active','Paused','Cancelled')),
    EnrolledAt   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Enrollment UNIQUE (StudentId, SessionId)
);
CREATE INDEX IX_Enrollments_Session ON dbo.Enrollments(SessionId, Status);

/* ---------- 5. Gallery, paintings for sale, custom requests ---------- */
CREATE TABLE dbo.StudentArtworks (               -- student gallery (no prices)
    ArtworkId    INT IDENTITY(1,1) PRIMARY KEY,
    StudentId    INT NULL REFERENCES dbo.Students(StudentId),
    Title        NVARCHAR(150) NOT NULL,
    ArtistName   NVARCHAR(120) NOT NULL,          -- shown publicly e.g. "Maya, 9"
    ArtTypeId    SMALLINT NOT NULL REFERENCES dbo.ArtTypes(ArtTypeId),
    ImageUrl     NVARCHAR(500) NULL,              -- file lives in Azure Blob Storage; store the URL only
    IsPublished  BIT NOT NULL DEFAULT 1,
    CreatedAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.Paintings (                     -- Gallery > Sale
    PaintingId   INT IDENTITY(1,1) PRIMARY KEY,
    Title        NVARCHAR(150) NOT NULL,
    ArtistName   NVARCHAR(120) NOT NULL DEFAULT 'Dream Arts',
    ArtTypeId    SMALLINT NOT NULL REFERENCES dbo.ArtTypes(ArtTypeId),
    SizeText     NVARCHAR(40) NULL,
    Price        DECIMAL(10,2) NOT NULL CHECK (Price >= 0),
    ImageUrl     NVARCHAR(500) NULL,
    Status       NVARCHAR(20) NOT NULL DEFAULT 'Available' CHECK (Status IN ('Available','Reserved','Sold')),
    CreatedAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.CustomRequests (
    RequestId    INT IDENTITY(1,1) PRIMARY KEY,
    UserId       INT NULL REFERENCES dbo.Users(UserId),
    Name         NVARCHAR(120) NOT NULL,
    Email        NVARCHAR(256) NOT NULL,
    Phone        NVARCHAR(30)  NULL,
    ArtTypeId    SMALLINT NULL REFERENCES dbo.ArtTypes(ArtTypeId),
    SizeText     NVARCHAR(40)  NULL,
    Budget       DECIMAL(10,2) NULL,
    Details      NVARCHAR(2000) NOT NULL,
    ReferenceImageUrl NVARCHAR(500) NULL,
    QuotedPrice  DECIMAL(10,2) NULL,
    Status       NVARCHAR(20) NOT NULL DEFAULT 'New'
                 CHECK (Status IN ('New','Quoted','In progress','Completed','Declined')),
    CreatedAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

/* ---------- 6. Payments ---------- */
CREATE TABLE dbo.Payments (
    PaymentId     INT IDENTITY(1,1) PRIMARY KEY,
    UserId        INT NULL REFERENCES dbo.Users(UserId),
    PayerName     NVARCHAR(120) NOT NULL,
    PayerEmail    NVARCHAR(256) NOT NULL,
    PaymentType   NVARCHAR(20)  NOT NULL CHECK (PaymentType IN ('Fees','Painting','Custom')),
    EnrollmentId  INT NULL REFERENCES dbo.Enrollments(EnrollmentId),
    PaintingId    INT NULL REFERENCES dbo.Paintings(PaintingId),
    RequestId     INT NULL REFERENCES dbo.CustomRequests(RequestId),
    Description   NVARCHAR(200) NOT NULL,
    Amount        DECIMAL(10,2) NOT NULL CHECK (Amount >= 0),
    Currency      CHAR(3) NOT NULL DEFAULT 'USD',
    Method        NVARCHAR(30) NOT NULL DEFAULT 'Invoice',        -- Card, Bank transfer, Pay at school, Invoice
    Status        NVARCHAR(20) NOT NULL DEFAULT 'Pending'
                  CHECK (Status IN ('Pending','Paid','Failed','Refunded')),
    ProviderRef   NVARCHAR(100) NULL,             -- transaction id from Stripe/Square etc. NEVER store card numbers.
    CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PaidAt        DATETIME2 NULL
);
CREATE INDEX IX_Payments_Status ON dbo.Payments(Status, CreatedAt DESC);
CREATE INDEX IX_Payments_User   ON dbo.Payments(UserId);
GO

/* ---------- 7. Useful view: how full is each session ---------- */
CREATE VIEW dbo.vw_SessionCapacity AS
SELECT s.SessionId, s.DayOfWeek, s.StartTime, s.EndTime, s.AgeGroup, s.Capacity,
       COUNT(e.EnrollmentId) AS Enrolled,
       s.Capacity - COUNT(e.EnrollmentId) AS SeatsLeft
FROM dbo.Sessions s
LEFT JOIN dbo.Enrollments e ON e.SessionId = s.SessionId AND e.Status = 'Active'
GROUP BY s.SessionId, s.DayOfWeek, s.StartTime, s.EndTime, s.AgeGroup, s.Capacity;
GO

/* ---------- 8. Starting data ---------- */
INSERT dbo.Roles (RoleId, RoleName) VALUES (1,'Admin'), (2,'User');

INSERT dbo.ArtTypes (Name, Description) VALUES
 ('Pencil & Charcoal','Shading, form and observational drawing.'),
 ('Watercolor','Color mixing, washes and landscapes.'),
 ('Oil Painting','Rich blending, layering and texture on canvas.'),
 ('Acrylic Painting','Bold colors on canvas, from first brushstroke.'),
 ('Pastel & Crayon','Soft, vibrant color for younger artists.'),
 ('Mixed Media','Paper, paint and found materials combined.');

INSERT dbo.Plans (Name, Price, Description, ClassCount) VALUES
 ('One-on-One Class', 35.00, 'Private one-on-one class with the teacher', 1),
 ('Monthly', 80.00, '4 classes per month', 4);

-- Mon-Fri 5-6 PM and 6-7 PM, Saturday 10-11 AM and 11 AM-12 PM. Sunday closed.
INSERT dbo.Sessions (DayOfWeek, StartTime, EndTime)
SELECT d.n, t.s, t.e
FROM (VALUES (1),(2),(3),(4),(5)) d(n)
CROSS JOIN (VALUES (CAST('17:00' AS TIME),CAST('18:00' AS TIME)), (CAST('18:00' AS TIME),CAST('19:00' AS TIME))) t(s,e);
INSERT dbo.Sessions (DayOfWeek, StartTime, EndTime) VALUES (6,'10:00','11:00'), (6,'11:00','12:00');
GO
