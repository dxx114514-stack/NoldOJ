// migrate-sqlite.js — sql.js → node:sqlite（内置 SQLite）迁移工具
//
// 背景：
//   WinOJ 原本使用 sql.js（WASM 内存数据库），每次写操作都会把整个数据库
//   导出写回磁盘，速度慢且有崩溃丢数据的风险。本版本改用 Node 内置的
//   node:sqlite（原生 SQLite，同步直写，无需任何 npm 依赖）。
//
// 关键点：
//   sql.js 的 db.export() 导出的文件本身就是标准 SQLite 格式，因此旧数据
//   无需转换，node:sqlite 可直接打开。本脚本负责：
//     1. 备份旧数据库
//     2. 完整性校验（PRAGMA integrity_check）
//     3. 统计各表行数，确认数据完好
//
// 使用方法：
//   cd backend
//   node ..\scripts\migrate-sqlite.js
//   或：
//   node scripts\migrate-sqlite.js
//
// 建议迁移流程：
//   1. 停止 WinOJ 服务（start.bat 窗口关闭即可）
//   2. 安装依赖：cd backend && npm install
//   3. 运行本脚本备份 + 校验
//   4. 启动服务：start.bat（initDB 会自动打开旧库并执行迁移）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

function log(msg) { console.log(`[migrate] ${msg}`); }
function logError(msg) { console.error(`[migrate][ERROR] ${msg}`); }

// 1. 定位数据库文件
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'backend', 'data', 'winoj.db');
if (!fs.existsSync(DB_PATH)) {
  logError(`未找到数据库文件: ${DB_PATH}`);
  logError('如果从未运行过旧版本（sql.js），无需迁移，直接启动服务即可。');
  process.exit(1);
}

log(`数据库文件: ${DB_PATH}`);
log(`文件大小: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);

// 2. 备份
const backupPath = DB_PATH + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
try {
  fs.copyFileSync(DB_PATH, backupPath);
  log(`已备份到: ${backupPath}`);
} catch (e) {
  logError(`备份失败: ${e.message}`);
  process.exit(1);
}

// 3. 校验并统计
try {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const integrity = db.prepare('PRAGMA integrity_check').all();
  const ok = integrity.length > 0 && integrity[0].integrity_check === 'ok';
  log(`完整性检查: ${ok ? 'PASS (ok)' : 'FAIL: ' + JSON.stringify(integrity)}`);
  if (!ok) {
    db.close();
    logError('数据库完整性检查失败，请勿启动服务，先恢复备份。');
    process.exit(1);
  }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  log(`共 ${tables.length} 张业务表:`);
  let totalRows = 0;
  for (const t of tables) {
    const { c } = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get();
    totalRows += c;
    console.log(`    ${t.name.padEnd(24)} ${c} 行`);
  }
  log(`合计 ${totalRows} 行数据，校验完毕。`);

  db.close();
} catch (e) {
  logError(`校验失败: ${e.message}`);
  process.exit(1);
}

log('');
log('迁移完成！数据已就绪，可放心启动服务。');
log('注意：启动时会自动执行 schema 迁移（initDB），并启用 WAL 模式，');
log('     数据库目录下会出现 winoj.db-wal / winoj.db-shm 文件，属正常现象。');
