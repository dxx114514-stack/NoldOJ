// 初始管理员口令策略：
// - 默认生成随机口令（生产行为，仅启动日志显示一次）
// - NoldOJ_INIT_ADMIN_PASSWORD 显式指定时使用该口令（CI 黑盒测试用），日志不回显明文
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noldoj-initpw-'));
const dbFile1 = path.join(tmp, 'with-env.db');
const dbFile2 = path.join(tmp, 'without-env.db');

function freshDb(dbFile, envPassword) {
  // config/db 在模块加载时读取 DB_PATH，切换库需先清缓存
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../database/db')];
  if (envPassword === undefined) delete process.env.NoldOJ_INIT_ADMIN_PASSWORD;
  else process.env.NoldOJ_INIT_ADMIN_PASSWORD = envPassword;
  process.env.DB_PATH = dbFile;
  const db = require('../database/db');
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  db.initDB();
  console.log = origLog;
  return { db, logs };
}

describe('初始管理员口令策略', () => {
  let envCase;
  let randomCase;

  before(() => {
    envCase = freshDb(dbFile1, 'admin123');
    randomCase = freshDb(dbFile2, undefined);
  });

  after(() => {
    try { envCase.db.closeDB(); } catch {}
    try { randomCase.db.closeDB(); } catch {}
    delete process.env.NoldOJ_INIT_ADMIN_PASSWORD;
    delete process.env.DB_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('NoldOJ_INIT_ADMIN_PASSWORD 指定的口令可用于登录校验', () => {
    const row = envCase.db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
    assert.ok(row, 'admin 用户应当存在');
    assert.ok(bcrypt.compareSync('admin123', row.password_hash), '指定口令应通过 bcrypt 校验');
  });

  it('环境变量指定口令时日志不回显明文', () => {
    const text = envCase.logs.join('\n');
    assert.ok(text.includes('NoldOJ_INIT_ADMIN_PASSWORD'), '日志应提示口令来自环境变量');
    assert.ok(!text.includes('admin123'), '日志不得回显口令明文');
  });

  it('未设置环境变量时生成随机口令（不等于默认测试口令）', () => {
    const row = randomCase.db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
    assert.ok(row, 'admin 用户应当存在');
    assert.equal(bcrypt.compareSync('admin123', row.password_hash), false, '默认不应是 admin123');
    assert.ok(randomCase.logs.join('\n').includes('仅此一次显示'), '随机口令应在日志显示一次');
  });
});
