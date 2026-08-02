const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

let sqlDb = null;

function saveDB() {
  if (!sqlDb) return;
  const data = sqlDb.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.database.path, buffer);
}

function prepare(sql) {
  return {
    get(...params) {
      const stmt = sqlDb.prepare(sql);
      if (params.length > 0 && Array.isArray(params[0])) stmt.bind(params[0]);
      else if (params.length > 0) stmt.bind(params);
      let result = undefined;
      if (stmt.step()) result = stmt.getAsObject();
      stmt.free();
      return result;
    },
    all(...params) {
      const stmt = sqlDb.prepare(sql);
      if (params.length > 0 && Array.isArray(params[0])) stmt.bind(params[0]);
      else if (params.length > 0) stmt.bind(params);
      const results = [];
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return results;
    },
    run(...params) {
      const flat = params.length > 0 && Array.isArray(params[0]) ? params[0] : params;
      sqlDb.run(sql, flat);
      const lastId = prepare('SELECT last_insert_rowid() as id').get()?.id;
      const changes = sqlDb.getRowsModified();
      saveDB();
      return { lastInsertRowid: lastId, changes };
    }
  };
}

// 表名白名单: 防止 SQL 注入（findNextId 仅由内部代码调用，但显式校验更安全）
const ALLOWED_TABLES = new Set([
  'users', 'problems', 'submissions', 'submission_details', 'test_cases',
  'test_groups', 'languages', 'contests', 'contest_problems', 'articles',
  'uploaded_files', 'refresh_tokens', 'ide_runs', 'tags', 'problem_tags',
  'categories', 'problem_categories', 'email_codes', 'announcements',
  'submission_files', 'problem_sets', 'problem_set_items', 'problem_set_progress',
  'discussions', 'discussion_replies', 'virtual_contests', 'plagiarism_tasks', 'plagiarism_pairs'
]);

function findNextId(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`findNextId: invalid table name "${table}"`);
  }
  const rows = sqlDb.exec(`SELECT id FROM ${table} ORDER BY id`);
  if (rows.length === 0 || rows[0].values.length === 0) return 1;
  const ids = rows[0].values.map(r => r[0]).sort((a, b) => a - b);
  if (ids[0] > 1) return 1;
  for (let i = 0; i < ids.length - 1; i++) {
    if (ids[i + 1] - ids[i] > 1) return ids[i] + 1;
  }
  return ids[ids.length - 1] + 1;
}

function exec(sql) {
  sqlDb.exec(sql);
  saveDB();
}

async function initDB() {
  const SQL = await initSqlJs();
  const dbDir = path.dirname(config.database.path);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  let existingData = null;
  if (fs.existsSync(config.database.path)) {
    existingData = fs.readFileSync(config.database.path);
  }
  sqlDb = existingData ? new SQL.Database(existingData) : new SQL.Database();
  sqlDb.run('PRAGMA journal_mode = WAL');
  sqlDb.run('PRAGMA foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  sqlDb.exec(schema);

  const colsResult = sqlDb.exec("PRAGMA table_info(users)");
  const cols = colsResult.length > 0 ? colsResult[0].values.map(r => r[1]) : [];
  if (!cols.includes('signature')) sqlDb.exec("ALTER TABLE users ADD COLUMN signature TEXT DEFAULT ''");
  if (!cols.includes('bio')) sqlDb.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
  if (!cols.includes('provider')) sqlDb.exec("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT ''");
  if (!cols.includes('rating')) sqlDb.exec("ALTER TABLE users ADD COLUMN rating INTEGER DEFAULT 1500");
  if (!cols.includes('hide_rating')) sqlDb.exec("ALTER TABLE users ADD COLUMN hide_rating INTEGER DEFAULT 0");
  if (!cols.includes('preferred_language')) sqlDb.exec("ALTER TABLE users ADD COLUMN preferred_language TEXT DEFAULT ''");
  if (!cols.includes('force_logout_at')) sqlDb.exec("ALTER TABLE users ADD COLUMN force_logout_at TEXT DEFAULT ''");

  const probColsResult = sqlDb.exec("PRAGMA table_info(problems)");
  const probCols = probColsResult.length > 0 ? probColsResult[0].values.map(r => r[1]) : [];
  if (!probCols.includes('provider')) sqlDb.exec("ALTER TABLE problems ADD COLUMN provider TEXT DEFAULT ''");
  if (!probCols.includes('sample_input')) sqlDb.exec("ALTER TABLE problems ADD COLUMN sample_input TEXT DEFAULT ''");
  if (!probCols.includes('sample_output')) sqlDb.exec("ALTER TABLE problems ADD COLUMN sample_output TEXT DEFAULT ''");
  if (!probCols.includes('difficulty')) sqlDb.exec("ALTER TABLE problems ADD COLUMN difficulty INTEGER DEFAULT 0");

  const artColsResult = sqlDb.exec("PRAGMA table_info(articles)");
  const artCols = artColsResult.length > 0 ? artColsResult[0].values.map(r => r[1]) : [];
  if (!artCols.includes('provider')) sqlDb.exec("ALTER TABLE articles ADD COLUMN provider TEXT DEFAULT ''");

  const subCheck = sqlDb.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='submissions'");
  if (subCheck.length > 0 && subCheck[0].values.length > 0) {
    const createSql = subCheck[0].values[0][0];
    if (!createSql.includes('pending_review')) {
      sqlDb.exec("ALTER TABLE submissions RENAME TO submissions_old");
      sqlDb.exec(`CREATE TABLE submissions (
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
      )`);
      sqlDb.exec("INSERT INTO submissions SELECT * FROM submissions_old");
      sqlDb.exec("DROP TABLE submissions_old");
      sqlDb.exec("CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id)");
      sqlDb.exec("CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id)");
      sqlDb.exec("CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)");
      console.log('[DB] submissions table CHECK constraint updated with pending_review');
    }
  }

  const ideColsResult = sqlDb.exec("PRAGMA table_info(ide_runs)");
  const ideCols = ideColsResult.length > 0 ? ideColsResult[0].values.map(r => r[1]) : [];
  if (!ideCols.includes('status')) sqlDb.exec("ALTER TABLE ide_runs ADD COLUMN status TEXT DEFAULT 'pending'");
  if (!ideCols.includes('compile_output')) sqlDb.exec("ALTER TABLE ide_runs ADD COLUMN compile_output TEXT DEFAULT ''");
  if (!ideCols.includes('memory_used')) sqlDb.exec("ALTER TABLE ide_runs ADD COLUMN memory_used INTEGER DEFAULT 0");

  if (!cols.includes('submit_lock_exempt')) sqlDb.exec("ALTER TABLE users ADD COLUMN submit_lock_exempt INTEGER DEFAULT 0");
  if (!cols.includes('email')) sqlDb.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");
  if (!cols.includes('email_verified')) sqlDb.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0");
  if (!cols.includes('max_file_size')) sqlDb.exec("ALTER TABLE users ADD COLUMN max_file_size INTEGER DEFAULT 0");
  if (!cols.includes('max_storage')) sqlDb.exec("ALTER TABLE users ADD COLUMN max_storage INTEGER DEFAULT 0");

  const tcColsResult = sqlDb.exec("PRAGMA table_info(test_cases)");
  const tcCols = tcColsResult.length > 0 ? tcColsResult[0].values.map(r => r[1]) : [];
  if (!tcCols.includes('time_limit')) sqlDb.exec("ALTER TABLE test_cases ADD COLUMN time_limit INTEGER");
  if (!tcCols.includes('memory_limit')) sqlDb.exec("ALTER TABLE test_cases ADD COLUMN memory_limit INTEGER");

  const tagsTableExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'");
  if (tagsTableExists.length === 0 || tagsTableExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#6366f1',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS problem_tags (
      problem_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (problem_id, tag_id),
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_problem_tags_problem ON problem_tags(problem_id)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag_id)');
  }

  // 预置标签
  const presetTagCount = prepare('SELECT COUNT(*) as c FROM tags').get()?.c || 0;
  if (presetTagCount === 0) {
    const presetTags = [
      ['模拟', '#6366f1'], ['贪心', '#10b981'], ['DP', '#f59e0b'], ['图论', '#3b82f6'],
      ['数据结构', '#8b5cf6'], ['数学', '#ef4444'], ['字符串', '#14b8a6'],
      ['搜索', '#ec4899'], ['二分', '#0ea5e9'], ['构造', '#84cc16']
    ];
    const ins = prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)');
    for (const [name, color] of presetTags) ins.run(name, color);
  }

  const categoriesExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'");
  if (categoriesExists.length === 0 || categoriesExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS problem_categories (
      problem_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (problem_id, category_id),
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    )`);
    const catCount = sqlDb.prepare('SELECT COUNT(*) as c FROM categories').get().c;
    if (catCount === 0) {
      const ins = sqlDb.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)');
      ins.run('一代上', '第一学年 上学期', 1);
      ins.run('一代下', '第一学年 下学期', 2);
      ins.run('二代上', '第二学年 上学期', 3);
      ins.run('二代下', '第二学年 下学期', 4);
      ins.run('三代上', '第三学年 上学期', 5);
      ins.run('三代下', '第三学年 下学期', 6);
    }
  }
  saveDB();

  const emailCodesExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='email_codes'");
  if (emailCodesExists.length === 0 || emailCodesExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS email_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email)');
  }

  // 功能6：contests 表添加冻结字段
  const contestColsResult = sqlDb.exec("PRAGMA table_info(contests)");
  const contestCols = contestColsResult.length > 0 ? contestColsResult[0].values.map(r => r[1]) : [];
  if (!contestCols.includes('freeze_minutes')) sqlDb.exec("ALTER TABLE contests ADD COLUMN freeze_minutes INTEGER DEFAULT 0");
  if (!contestCols.includes('unfrozen')) sqlDb.exec("ALTER TABLE contests ADD COLUMN unfrozen INTEGER DEFAULT 0");
  if (!contestCols.includes('unfrozen_at')) sqlDb.exec("ALTER TABLE contests ADD COLUMN unfrozen_at TEXT");

  // 功能7：题单表
  const psExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='problem_sets'");
  if (psExists.length === 0 || psExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS problem_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_id INTEGER NOT NULL,
      is_public INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS problem_set_items (
      set_id INTEGER NOT NULL,
      problem_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      PRIMARY KEY (set_id, problem_id),
      FOREIGN KEY (set_id) REFERENCES problem_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS problem_set_progress (
      user_id INTEGER NOT NULL,
      set_id INTEGER NOT NULL,
      problem_id INTEGER NOT NULL,
      solved INTEGER DEFAULT 0,
      solved_at TEXT,
      PRIMARY KEY (user_id, set_id, problem_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (set_id) REFERENCES problem_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_problem_sets_public ON problem_sets(is_public)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_problem_set_items_set ON problem_set_items(set_id)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_problem_set_progress_user ON problem_set_progress(user_id)');
  }

  // 功能8：讨论 / 题解区
  const discExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='discussions'");
  if (discExists.length === 0 || discExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS discussions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER,
      contest_id INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      is_official INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS discussion_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discussion_id INTEGER NOT NULL,
      parent_id INTEGER,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES discussion_replies(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_discussions_problem ON discussions(problem_id)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_discussions_contest ON discussions(contest_id)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_discussions_pinned ON discussions(pinned)');
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_discussion_replies_discussion ON discussion_replies(discussion_id)');
  }

  // 功能9：虚拟比赛
  const vcExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='virtual_contests'");
  if (vcExists.length === 0 || vcExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS virtual_contests (
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
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_virtual_contests_user ON virtual_contests(user_id)');
  }
  // submissions 表添加 virtual_contest_id 列
  const subColsResult2 = sqlDb.exec("PRAGMA table_info(submissions)");
  const subCols2 = subColsResult2.length > 0 ? subColsResult2[0].values.map(r => r[1]) : [];
  if (!subCols2.includes('virtual_contest_id')) sqlDb.exec("ALTER TABLE submissions ADD COLUMN virtual_contest_id INTEGER");

  // 功能10：代码查重任务表
  const plgExists = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='plagiarism_tasks'");
  if (plgExists.length === 0 || plgExists[0].values.length === 0) {
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS plagiarism_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      total_pairs INTEGER DEFAULT 0,
      checked_pairs INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
    )`);
    sqlDb.exec(`CREATE TABLE IF NOT EXISTS plagiarism_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_a INTEGER NOT NULL,
      user_b INTEGER NOT NULL,
      sub_a_id INTEGER NOT NULL,
      sub_b_id INTEGER NOT NULL,
      similarity REAL NOT NULL,
      level TEXT DEFAULT 'low',
      FOREIGN KEY (task_id) REFERENCES plagiarism_tasks(id) ON DELETE CASCADE
    )`);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_plagiarism_pairs_task ON plagiarism_pairs(task_id)');
  }

  const langCount = prepare('SELECT COUNT(*) as c FROM languages').get()?.c || 0;
  if (langCount === 0) {
    const ins = prepare('INSERT INTO languages (name, display_name, compile_cmd, run_cmd, extension) VALUES (?, ?, ?, ?, ?)');
    ins.run('c', 'C', 'gcc -O2 -Wall -o "{exe}" "{src}"', '"{exe}"', '.c');
    ins.run('cpp', 'C++', 'g++ -O2 -Wall -std=c++17 -o "{exe}" "{src}"', '"{exe}"', '.cpp');
    ins.run('python3', 'Python 3', '', 'python "{src}"', '.py');
    ins.run('java', 'Java', 'javac "{src}" -d "{workdir}"', 'java -cp "{workdir}" Main', '.java');
    ins.run('javascript', 'JavaScript', '', 'node "{src}"', '.js');
  }

  const adminCount = prepare("SELECT COUNT(*) as c FROM users WHERE username = 'admin'").get()?.c || 0;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    prepare('INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Super Admin', 'su');
  }
  saveDB();
}

const db = { prepare, exec, saveDB, findNextId };
module.exports = db;
module.exports.initDB = initDB;
