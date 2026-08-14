// 动态 UPDATE 构建工具: 统一 updates[]/values[] 拼接模式，消除 14 处重复代码。
// 用法:
//   const u = buildUpdates([
//     { key: 'title', value: body.title },
//     { key: 'is_public', value: body.is_public, transform: v => v ? 1 : 0 },
//   ], { touchUpdatedAt: true });
//   if (u.count === 0) return res.status(400).json(...);
//   db.prepare(`UPDATE t SET ${u.clause} WHERE id = ?`).run(...u.values, id);

function buildUpdates(fields, options = {}) {
  const set = [];
  const values = [];
  for (const f of fields) {
    if (f.value === undefined) continue;
    set.push(`${f.key} = ?`);
    values.push(f.transform ? f.transform(f.value) : f.value);
  }
  if (options.touchUpdatedAt) set.push("updated_at = datetime('now')");
  return { clause: set.join(', '), set, values, count: set.length };
}

module.exports = { buildUpdates };