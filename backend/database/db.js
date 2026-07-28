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

function findNextId(table) {
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
