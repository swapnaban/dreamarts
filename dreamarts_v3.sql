/* Dream Arts v3. Run once in the Azure Query editor, AFTER dreamarts_v2.sql. */

-- 1. Registration no longer asks for an art type, so the column must allow empty values
ALTER TABLE dbo.Enrollments ALTER COLUMN ArtTypeId SMALLINT NULL;

-- 2. Add a 5:30 PM-6:30 PM class Monday-Friday. Existing slots: 5-6 PM and 6-7 PM. Every class is 1 hour; the last ends at 7 PM.
INSERT dbo.Sessions (DayOfWeek, StartTime, EndTime)
SELECT d.n, '17:30', '18:30'
FROM (VALUES (1),(2),(3),(4),(5)) d(n)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Sessions s WHERE s.DayOfWeek = d.n AND s.StartTime = '17:30');
