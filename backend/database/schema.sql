CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT DEFAULT '',
  role TEXT DEFAULT 'user' CHECK(role IN ('user','teacher','admin','su')),
  banned INTEGER DEFAULT 0,
  signature TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  rating INTEGER DEFAULT 1500,
  hide_rating INTEGER DEFAULT 0,
  preferred_language TEXT DEFAULT '',
  force_logout_at TEXT DEFAULT '',
  submit_lock_exempt INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS languages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  compile_cmd TEXT DEFAULT '',
  run_cmd TEXT NOT NULL,
  extension TEXT NOT NULL,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  input_desc TEXT DEFAULT '',
  output_desc TEXT DEFAULT '',
  hint TEXT DEFAULT '',
  time_limit INTEGER DEFAULT 1000,
  memory_limit INTEGER DEFAULT 256,
  problem_type TEXT DEFAULT 'traditional' CHECK(problem_type IN ('traditional','interactive','communication','submit_answer')),
  compare_mode TEXT DEFAULT 'text_strict' CHECK(compare_mode IN ('text_strict','text_relaxed','real_number','spj')),
  real_number_tolerance TEXT DEFAULT '{"absolute":0.001,"relative":0.001}',
  spj_code TEXT DEFAULT '',
  allowed_languages TEXT DEFAULT '[]',
  subtask_mode TEXT DEFAULT 'simple' CHECK(subtask_mode IN ('simple','advanced')),
  scoring_script TEXT DEFAULT '',
  sample_input TEXT DEFAULT '',
  sample_output TEXT DEFAULT '',
  is_public INTEGER DEFAULT 1,
  provider TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS test_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  subtask_id TEXT NOT NULL,
  score REAL DEFAULT 0,
  aggregator TEXT DEFAULT 'sum' CHECK(aggregator IN ('sum','min','max','min_score','max_time','custom')),
  dependency TEXT DEFAULT '[]',
  scoring_script TEXT DEFAULT '',
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  group_id INTEGER,
  input_data TEXT DEFAULT '',
  output_data TEXT DEFAULT '',
  score REAL DEFAULT 0,
  input_file TEXT DEFAULT '',
  output_file TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES test_groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  source_code TEXT DEFAULT '',
  answer_data TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','compiling','judging','accepted','wrong_answer','time_limit_exceeded','memory_limit_exceeded','runtime_error','compile_error','system_error','pending_rejudge','pending_review')),
  score REAL DEFAULT 0,
  time_used INTEGER DEFAULT 0,
  memory_used INTEGER DEFAULT 0,
  compile_output TEXT DEFAULT '',
  JudgerDetail TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submission_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  test_case_id INTEGER,
  group_id INTEGER,
  subtask_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  score REAL DEFAULT 0,
  time_used INTEGER DEFAULT 0,
  memory_used INTEGER DEFAULT 0,
  stdout TEXT DEFAULT '',
  stderr TEXT DEFAULT '',
  exit_code INTEGER DEFAULT -1,
  checker_output TEXT DEFAULT '',
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES test_groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_virtual INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS contest_problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  alias TEXT DEFAULT '',
  FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contest_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  invited_by INTEGER,
  joined_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(contest_id, user_id)
);

CREATE TABLE IF NOT EXISTS ide_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  language TEXT NOT NULL,
  source_code TEXT NOT NULL,
  stdin TEXT DEFAULT '',
  stdout TEXT DEFAULT '',
  stderr TEXT DEFAULT '',
  exit_code INTEGER DEFAULT -1,
  time_used INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','pending_review','running','compiling','accepted','wrong_answer','runtime_error','compile_error','system_error')),
  compile_output TEXT DEFAULT '',
  memory_used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_test_cases_problem ON test_cases(problem_id);
CREATE INDEX IF NOT EXISTS idx_submission_details_submission ON submission_details(submission_id);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  author_id INTEGER NOT NULL,
  provider TEXT DEFAULT '',
  is_published INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS problem_solutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  show_after_contest INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problem_tags (
  problem_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (problem_id, tag_id),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_problem_tags_problem ON problem_tags(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag_id);
