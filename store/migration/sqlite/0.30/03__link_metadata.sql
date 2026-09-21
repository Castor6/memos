CREATE TABLE link_metadata (
  url_hash VARCHAR(64) PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  image TEXT NOT NULL
);
