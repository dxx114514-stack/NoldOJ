// 测试隔离：需要数据库的测试统一改用独立临时库，
// 避免读写生产库 backend/data/NoldOJ.db（测试中断也不留下脏数据）。
// 必须在 require('../database/db') 之前调用（config 在模块加载时读取 DB_PATH）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = function useTestDb(name) {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const dir = path.join(os.tmpdir(), 'NoldOJ-test');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.db`);
  process.env.DB_PATH = file;
  return file;
};
