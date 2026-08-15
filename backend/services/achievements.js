const db = require('../database/db');

// 成就检查：在每次评测结束（无论是否 AC）后调用，按需解锁并返回新增成就列表。
// 为控制开销，仅当提交为 accepted 或提交数达阈值时才跑较重统计。
function checkAchievements(userId, problemId, language, createdAt) {
  if (!userId) return [];
  const unlocked = new Set(
    db.prepare('SELECT achievement_id FROM user_achievements WHERE user_id = ?').all(userId).map(r => r.achievement_id)
  );
  const added = [];

  function unlock(code) {
    const a = db.prepare('SELECT * FROM achievements WHERE code = ?').get(code);
    if (a && !unlocked.has(a.id)) {
      try {
        db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)').run(userId, a.id);
        unlocked.add(a.id);
        added.push(a);
      } catch {}
    }
  }

  const hour = new Date(createdAt.replace(' ', 'T')).getHours();

  if (hour >= 2 && hour < 5) {
    unlock('night_owl');
  }

  // 当日（UTC）是否算"登录做题"：以提交 created_at 的日期为准
  const day = createdAt.slice(0, 10);

  // 汇总统计
  const totalAccepted = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND status = 'accepted'").get(userId).c;
  const totalSubmits = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ?').get(userId).c;

  if (totalAccepted === 1) unlock('first_ac');
  if (totalAccepted >= 10) unlock('ac_10');
  if (totalAccepted >= 50) unlock('ac_50');
  if (totalAccepted >= 100) unlock('ac_100');
  if (totalSubmits >= 100) unlock('submit_100');

  // 全能选手：用 C++ / Python / Java 三种语言 AC 同一题
  if (language && problemId) {
    const langs = db.prepare(
      "SELECT DISTINCT language FROM submissions WHERE user_id = ? AND problem_id = ? AND status = 'accepted'"
    ).all(userId, problemId).map(r => r.language);
    const target = ['cpp', 'c++', 'python3', 'python', 'java'];
    const have = new Set(langs.map(l => l.toLowerCase().replace(/\s+/g, '')));
    const hit = new Set();
    if (have.has('cpp') || have.has('c++')) hit.add('cpp');
    if (have.has('python3') || have.has('python')) hit.add('python');
    if (have.has('java')) hit.add('java');
    if (hit.size >= 3) unlock('all_rounder');
  }

  // 连续做题天数（按日期去重后找最长连续段）
  unlockStreak(userId, day, unlock);

  return added;
}

// 计算截至 day 的连续做题天数，满足 3/7/30 即解锁
function unlockStreak(userId, day, unlock) {
  const days = db.prepare(
    'SELECT DISTINCT substr(created_at, 1, 10) as d FROM submissions WHERE user_id = ? ORDER BY d DESC'
  ).all(userId).map(r => r.d);
  const set = new Set(days);
  let maxStreak = 0, cur = 0;
  // 从今天向前统计连续段
  for (let d = new Date(day + 'T00:00:00Z'); ; d.setUTCDate(d.getUTCDate() - 1)) {
    const key = d.toISOString().slice(0, 10);
    if (set.has(key)) {
      cur++;
      if (cur > maxStreak) maxStreak = cur;
    } else {
      break;
    }
  }
  if (maxStreak >= 3) unlock('streak_3');
  if (maxStreak >= 7) unlock('streak_7');
  if (maxStreak >= 30) unlock('streak_30');
}

module.exports = { checkAchievements };