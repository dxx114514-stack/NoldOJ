const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const config = require('../config/config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BOOT_TIME = Date.now();
const START_MEM = process.memoryUsage().rss;

// 功能16：系统运行状态仪表盘（admin+）
// GET /api/v1/system/status
router.get('/status', requireAuth, (req, res) => {
  if (!['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '仅管理员可查看系统状态。' });
  }

  const uptimeMs = Date.now() - BOOT_TIME;
  const mem = process.memoryUsage();
  const dbSize = (() => {
    try { return fs.statSync(config.database.path).size; } catch { return 0; }
  })();

  const counts = {
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    problems: db.prepare('SELECT COUNT(*) as c FROM problems').get().c,
    submissions: db.prepare('SELECT COUNT(*) as c FROM submissions').get().c,
    testCases: db.prepare('SELECT COUNT(*) as c FROM test_cases').get().c,
    pendingReview: db.prepare("SELECT COUNT(*) as c FROM submissions WHERE status = 'pending_review'").get().c
  };

  // 判题队列：最近处理中的提交
  const queue = db.prepare(`
    SELECT id, user_id, problem_id, language, status, created_at
    FROM submissions
    WHERE status IN ('pending','running','compiling','judging','pending_rejudge')
    ORDER BY id DESC LIMIT 20
  `).all();

  const today = new Date().toISOString().slice(0, 10);
  const todayStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM submissions WHERE date(created_at) = ?) as today_submits,
      (SELECT COUNT(*) FROM submissions WHERE date(created_at) = ? AND status = 'accepted') as today_ac,
      (SELECT COUNT(*) FROM users WHERE date(created_at) = ?) as today_users
  `).get(today, today, today);

  res.json({
    ok: true,
    ts: Date.now(),
    uptime_ms: uptimeMs,
    started_at: new Date(BOOT_TIME).toISOString(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()} (${os.release()})`,
    cpu_cores: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || '',
    loadavg: os.loadavg(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    memory: {
      rss: mem.rss,
      heap_total: mem.heapTotal,
      heap_used: mem.heapUsed,
      start_rss: START_MEM
    },
    node: process.version,
    db_size: dbSize,
    counts,
    today_stats: {
      submits: todayStats.today_submits,
      accepted: todayStats.today_ac,
      new_users: todayStats.today_users
    },
    queue
  });
});

module.exports = router;