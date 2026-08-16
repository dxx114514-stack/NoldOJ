CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT DEFAULT '',
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
  token_prefix TEXT DEFAULT '',
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
  difficulty INTEGER DEFAULT 0,
  is_public INTEGER DEFAULT 1,
  is_hidden INTEGER DEFAULT 0,
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
  time_limit INTEGER,
  memory_limit INTEGER,
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
  first_accepted INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_submission_files_submission ON submission_files(submission_id);

CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_virtual INTEGER DEFAULT 0,
  freeze_minutes INTEGER DEFAULT 0,
  unfrozen INTEGER DEFAULT 0,
  unfrozen_at TEXT,
  is_hidden INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS problem_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  creator_id INTEGER NOT NULL,
  is_public INTEGER DEFAULT 1,
  type TEXT DEFAULT 'public' CHECK(type IN ('public','personal')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS problem_set_items (
  set_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (set_id, problem_id),
  FOREIGN KEY (set_id) REFERENCES problem_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS problem_set_progress (
  user_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  solved INTEGER DEFAULT 0,
  solved_at TEXT,
  PRIMARY KEY (user_id, set_id, problem_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (set_id) REFERENCES problem_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_problem_sets_public ON problem_sets(is_public);
CREATE INDEX IF NOT EXISTS idx_problem_set_items_set ON problem_set_items(set_id);
CREATE INDEX IF NOT EXISTS idx_problem_set_progress_user ON problem_set_progress(user_id);

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
-- R9-18: 热查询索引（提交列表/AC 状态/首 AC 原子占位）
CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_submissions_user_problem_status ON submissions(user_id, problem_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_problem_status ON submissions(problem_id, status);
CREATE INDEX IF NOT EXISTS idx_test_cases_problem ON test_cases(problem_id);
CREATE INDEX IF NOT EXISTS idx_submission_details_submission ON submission_details(submission_id);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  author_id INTEGER NOT NULL,
  provider TEXT DEFAULT '',
  is_published INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problem_categories (
  problem_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (problem_id, category_id),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_problem_tags_problem ON problem_tags(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag_id);

CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'global' CHECK(type IN ('global','contest')),
  contest_id INTEGER,
  pinned INTEGER DEFAULT 0,
  author_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_announcements_type ON announcements(type);
CREATE INDEX IF NOT EXISTS idx_announcements_contest ON announcements(contest_id);
CREATE INDEX IF NOT EXISTS idx_announcements_pinned ON announcements(pinned);

-- 功能8：讨论 / 题解区
CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER,
  contest_id INTEGER,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  is_official INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  locked INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS discussion_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id INTEGER NOT NULL,
  parent_id INTEGER,
  content TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES discussion_replies(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_discussions_problem ON discussions(problem_id);
CREATE INDEX IF NOT EXISTS idx_discussions_contest ON discussions(contest_id);
CREATE INDEX IF NOT EXISTS idx_discussions_pinned ON discussions(pinned);
CREATE INDEX IF NOT EXISTS idx_discussion_replies_discussion ON discussion_replies(discussion_id);

-- 题目收藏（个人收藏夹）
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, problem_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

-- 成就定义（预置种子）
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon TEXT DEFAULT '🏅',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 用户已解锁成就
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL,
  achievement_id INTEGER NOT NULL,
  unlocked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, achievement_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
);
