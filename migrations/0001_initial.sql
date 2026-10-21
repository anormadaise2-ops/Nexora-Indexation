CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'meta',
  created_at TEXT NOT NULL,
  verified_at TEXT,
  last_crawl_at TEXT,
  last_submitted_sitemap TEXT,
  sitemaps_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  canonical TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(site_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_status_updated ON pages(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site_id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  crawled INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_site_status ON jobs(site_id, status);
