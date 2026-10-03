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
  hide_achievements INTEGER DEFAULT 0,
  hide_dashboard INTEGER DEFAULT 0,
  hide_favorites INTEGER DEFAULT 0,
  preferred_language TEXT DEFAULT '',
  force_logout_at TEXT DEFAULT '',
  submit_lock_exempt INTEGER DEFAULT 0,
  email_verified INTEGER DEFAULT 0,
  max_file_size INTEGER DEFAULT 0,
  max_storage INTEGER DEFAULT 0,
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
  background TEXT DEFAULT '',
  input_desc TEXT DEFAULT '',
  output_desc TEXT DEFAULT '',
  hint TEXT DEFAULT '',
  time_limit INTEGER DEFAULT 1000,
  memory_limit INTEGER DEFAULT 256,
  problem_type TEXT DEFAULT 'traditional' CHECK(problem_type IN ('traditional','interactive','communication','submit_answer','file_io')),
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
  exam_id INTEGER,  -- 非空 = 试卷内编程题（隔离于题库），EXAM_PROBLEM_ID_BASE 号段
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
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
  virtual_contest_id INTEGER,
  exam_id INTEGER,        -- 非空 = 试卷考试提交（全站记录/统计/成就隔离）
  exam_attempt INTEGER DEFAULT 0, -- 所属考试尝试次数（从 1 起），同尝试每题仅 1 次
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
  id INTEGER PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS problem_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  input TEXT DEFAULT '',
  output TEXT DEFAULT '',
  note TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_problem_samples_problem ON problem_samples(problem_id);
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

-- 功能9：虚拟比赛
CREATE TABLE IF NOT EXISTS virtual_contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(contest_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_virtual_contests_user ON virtual_contests(user_id);

-- 功能10：代码查重任务表
CREATE TABLE IF NOT EXISTS plagiarism_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  total_pairs INTEGER DEFAULT 0,
  checked_pairs INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plagiarism_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  sub_a_id INTEGER NOT NULL,
  sub_b_id INTEGER NOT NULL,
  similarity REAL NOT NULL,
  level TEXT DEFAULT 'low',
  FOREIGN KEY (task_id) REFERENCES plagiarism_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plagiarism_pairs_task ON plagiarism_pairs(task_id);

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

-- ═══════════════════════════════════════════════════════
-- 试卷系统
-- ═══════════════════════════════════════════════════════

-- 试卷/考试
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  time_limit INTEGER DEFAULT 0,  -- 时间限制（分钟），0=不限时
  total_score REAL DEFAULT 0,    -- 总分（自动计算）
  pass_score REAL DEFAULT 0,     -- 及格分
  max_attempts INTEGER DEFAULT 1, -- 最大尝试次数，0=不限
  show_answer INTEGER DEFAULT 0, -- 提交后是否显示答案
  is_public INTEGER DEFAULT 1,
  is_hidden INTEGER DEFAULT 0,
  allow_ai_grading INTEGER DEFAULT 1, -- 是否允许 AI 评分主观题
  start_time TEXT,                 -- 开考时间（ISO8601，NULL=不限；期间外禁止作答）
  end_time TEXT,                   -- 结束时间（NULL=不限，且不参与自动封榜）
  freeze_minutes INTEGER DEFAULT 0, -- 结束前 N 分钟自动封榜，0=不自动封榜
  leaderboard_enabled INTEGER DEFAULT 1, -- 启用排行榜
  leaderboard_view_incomplete INTEGER DEFAULT 0, -- 未交卷用户能否查看排行榜，0=仅完成者
  manual_frozen INTEGER DEFAULT 0, -- 手动封榜开关
  manual_frozen_at TEXT,           -- 手动封榜时刻（榜单快照锚点，UTC）
  unfrozen INTEGER DEFAULT 0,      -- 手动解榜开关（抑制自动封榜窗口）
  creator_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 试卷题目
CREATE TABLE IF NOT EXISTS exam_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  question_type TEXT NOT NULL CHECK(question_type IN ('choice','true_false','fill_blank','long_answer','program')),
  title TEXT NOT NULL,           -- 题目内容
  options TEXT DEFAULT '[]',     -- 选项（选择题/判断题用），JSON 数组
  correct_answer TEXT DEFAULT '', -- 正确答案（客观题）
  score REAL DEFAULT 0,          -- 该题分值
  sort_order INTEGER DEFAULT 0,
  is_subjective INTEGER DEFAULT 0, -- 填空题：0=客观题，1=主观题
  ai_grading_prompt TEXT DEFAULT '', -- AI 评分提示词（可选）
  problem_id INTEGER,            -- 题型 program 时关联的内部题目（EXAM_PROBLEM_ID_BASE 号段）
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

-- 试卷提交记录
CREATE TABLE IF NOT EXISTS exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT DEFAULT 'submitted' CHECK(status IN ('submitted','grading','graded')),
  total_score REAL DEFAULT 0,
  max_score REAL DEFAULT 0,
  ai_graded INTEGER DEFAULT 0,   -- 是否有 AI 评分
  human_graded INTEGER DEFAULT 0, -- 是否有人工评分
  submitted_at TEXT DEFAULT (datetime('now')),
  graded_at TEXT,
  graded_by INTEGER,
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (graded_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 试卷答题记录
CREATE TABLE IF NOT EXISTS exam_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer TEXT DEFAULT '',         -- 用户答案
  score REAL DEFAULT 0,          -- 得分
  max_score REAL DEFAULT 0,      -- 满分
  is_correct INTEGER DEFAULT 0,  -- 客观题是否正确
  is_subjective INTEGER DEFAULT 0, -- 是否主观题
  grading_status TEXT DEFAULT 'pending' CHECK(grading_status IN ('pending','ai_graded','human_graded')),
  ai_comment TEXT DEFAULT '',    -- AI 评语
  human_comment TEXT DEFAULT '', -- 人工评语
  code_submission_id INTEGER,    -- 题型 program 时关联的代码提交（判题完成后回填分数）
  graded_at TEXT,
  FOREIGN KEY (submission_id) REFERENCES exam_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_exams_creator ON exams(creator_id);
CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_submissions_exam ON exam_submissions(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_submissions_user ON exam_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_exam_answers_submission ON exam_answers(submission_id);

-- 考试作答起始时刻（服务端强制 time_limit 用）
-- 每次 attempt 第一次进入考试即写入，刷新页面不会重置，防止前端倒计时被绕过
CREATE TABLE IF NOT EXISTS exam_attempts (
  exam_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (exam_id, user_id, attempt),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

