// 分页参数规范化: 自动钳制 limit 上限，防止超大数据量查询造成 DoS
function parsePageLimit(page, limit, defaultLimit = 50, maxLimit = 200) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  let l = parseInt(limit, 10);
  if (isNaN(l) || l < 1) l = defaultLimit;
  l = Math.min(l, maxLimit);
  return { page: p, limit: l, offset: (p - 1) * l };
}

module.exports = { parsePageLimit };