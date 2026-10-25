/* v4: remove Digital Art everywhere (hidden from the API; old rows stay valid). Safe to run more than once. */
UPDATE dbo.ArtTypes SET IsActive = 0 WHERE Name = 'Digital Art';
