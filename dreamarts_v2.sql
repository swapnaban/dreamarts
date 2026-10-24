/* Dream Arts v2 migration: approval workflow, Zelle, requests, images. Run once in the Azure Query editor.
   (If your editor complains, select and run each numbered block separately.) */

-- 1. Enrollment statuses: add Pending (awaiting admin approval) and Declined
DECLARE @c sysname = (SELECT TOP 1 name FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID('dbo.Enrollments') AND definition LIKE '%Active%');
IF @c IS NOT NULL EXEC('ALTER TABLE dbo.Enrollments DROP CONSTRAINT ' + @c);
ALTER TABLE dbo.Enrollments ADD CONSTRAINT CK_Enrollments_Status CHECK (Status IN ('Pending','Active','Paused','Cancelled','Declined'));

-- 2. Payment statuses: add Submitted (parent says they sent the Zelle payment)
DECLARE @p sysname = (SELECT TOP 1 name FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID('dbo.Payments') AND definition LIKE '%Refunded%');
IF @p IS NOT NULL EXEC('ALTER TABLE dbo.Payments DROP CONSTRAINT ' + @p);
ALTER TABLE dbo.Payments ADD CONSTRAINT CK_Payments_Status CHECK (Status IN ('Pending','Submitted','Paid','Failed','Refunded'));

-- 3. Pending seats count toward capacity
EXEC('ALTER VIEW dbo.vw_SessionCapacity AS
SELECT s.SessionId, s.DayOfWeek, s.StartTime, s.EndTime, s.AgeGroup, s.Capacity,
       COUNT(e.EnrollmentId) AS Enrolled, s.Capacity - COUNT(e.EnrollmentId) AS SeatsLeft
FROM dbo.Sessions s LEFT JOIN dbo.Enrollments e ON e.SessionId = s.SessionId AND e.Status IN (''Pending'',''Active'')
GROUP BY s.SessionId, s.DayOfWeek, s.StartTime, s.EndTime, s.AgeGroup, s.Capacity');

-- 4. Images (painting photos, Zelle QR, reference photos). Small JPEGs stored in the database.
CREATE TABLE dbo.Images (
    ImageId     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    ContentType NVARCHAR(50)  NOT NULL,
    Data        VARBINARY(MAX) NOT NULL,
    CreatedAt   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- 5. Settings (Zelle phone + QR image id)
CREATE TABLE dbo.Settings (
    SettingKey   NVARCHAR(50)  NOT NULL PRIMARY KEY,
    SettingValue NVARCHAR(500) NULL
);

-- 6. Parent requests: schedule change, additional class, missed class
CREATE TABLE dbo.ChangeRequests (
    RequestId          INT IDENTITY(1,1) PRIMARY KEY,
    UserId             INT NOT NULL REFERENCES dbo.Users(UserId),
    EnrollmentId       INT NULL REFERENCES dbo.Enrollments(EnrollmentId),
    RequestType        NVARCHAR(20) NOT NULL CHECK (RequestType IN ('ScheduleChange','AdditionalClass','MissedClass')),
    PreferredSessionId INT NULL REFERENCES dbo.Sessions(SessionId),
    ClassDate          DATE NULL,                       -- the missed class date
    Message            NVARCHAR(1000) NULL,
    Status             NVARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending','Approved','Declined')),
    AdminNote          NVARCHAR(500) NULL,
    CreatedAt          DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ResolvedAt         DATETIME2 NULL
);
CREATE INDEX IX_ChangeRequests_User ON dbo.ChangeRequests(UserId, CreatedAt DESC);
