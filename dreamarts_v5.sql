-- Dream Arts v5: Fees update. Run once in the Azure SQL query editor (safe to run again).
-- Hides Drop-in and Term (12 weeks) (existing enrollments keep their plan), adds the One-on-One class at $35.
UPDATE dbo.Plans SET IsActive = 0 WHERE Name IN (N'Drop-in', N'Term (12 weeks)');
IF EXISTS (SELECT 1 FROM dbo.Plans WHERE Name = N'One-on-One Class')
    UPDATE dbo.Plans SET Price = 35, Description = N'Private one-on-one class with the teacher', ClassCount = 1, IsActive = 1 WHERE Name = N'One-on-One Class';
ELSE
    INSERT dbo.Plans (Name, Price, Description, ClassCount, IsActive) VALUES (N'One-on-One Class', 35, N'Private one-on-one class with the teacher', 1, 1);
SELECT PlanId, Name, Price, ClassCount, IsActive FROM dbo.Plans ORDER BY Price;
