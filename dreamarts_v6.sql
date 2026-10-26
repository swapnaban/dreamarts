-- Dream Arts v6: rename the art type. Run once in the Azure SQL query editor (safe to run again).
UPDATE dbo.ArtTypes SET Name = N'Mixed Media' WHERE Name = N'Mixed Media & Collage';
SELECT ArtTypeId, Name, IsActive FROM dbo.ArtTypes;
