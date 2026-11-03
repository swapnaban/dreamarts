-- Dream Arts v7: material list. Run once in the Azure SQL query editor (safe to run again).
-- StudentId NULL = general item shown to every family; otherwise the item is for that student only.
IF OBJECT_ID('dbo.MaterialItems') IS NULL
CREATE TABLE dbo.MaterialItems (
  ItemId    INT IDENTITY(1,1) PRIMARY KEY,
  StudentId INT NULL REFERENCES dbo.Students(StudentId),
  ItemName  NVARCHAR(150) NOT NULL,
  Notes     NVARCHAR(300) NULL,
  SortOrder INT NOT NULL DEFAULT 0,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF NOT EXISTS (SELECT 1 FROM dbo.MaterialItems WHERE StudentId IS NULL)
INSERT dbo.MaterialItems (StudentId, ItemName, Notes, SortOrder) VALUES
 (NULL, N'Pencils (HB and 2B)', N'', 1),
 (NULL, N'Eraser and sharpener', N'', 2),
 (NULL, N'Sketchbook', N'A4 or similar', 3),
 (NULL, N'Old shirt or apron', N'Paint can stain clothes', 4);
SELECT * FROM dbo.MaterialItems;
