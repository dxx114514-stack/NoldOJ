// 角色层级共享常量：从低到高。全项目统一引用，避免散落的魔法数组。
const ROLE_HIERARCHY = ['user', 'teacher', 'admin', 'su'];

function roleLevel(role) {
  return ROLE_HIERARCHY.indexOf(role);
}

function isValidRole(role) {
  return ROLE_HIERARCHY.includes(role);
}

// 角色是否属于管理/教师级别（能访问隐藏内容等）
function isStaff(role) {
  return role === 'teacher' || role === 'admin' || role === 'su';
}

// 角色是否属于管理员级别（不含 teacher）
function isAdminOrSu(role) {
  return role === 'admin' || role === 'su';
}

// 能否管理 target：target 级别必须严格低于操作者，或同级且是自己
function canManage(operator, target) {
  const myLevel = roleLevel(operator.role);
  const targetLevel = roleLevel(target.role);
  if (targetLevel > myLevel) return false;
  if (targetLevel === myLevel && String(target.id) !== String(operator.id)) return false;
  return true;
}

// 能否查看他人私有数据（成就/看板/收藏）:
// - 本人始终可看；admin/su 始终可看
// - 其余用户仅在目标未开启对应 hide_* 开关时可见
// hideField 为目标用户行中的 hide 开关列名（如 'hide_achievements'）
function canViewUserData(operator, target, hideField) {
  if (!operator || !target) return false;
  if (String(operator.id) === String(target.id)) return true;
  if (isAdminOrSu(operator.role)) return true;
  return !target[hideField];
}

module.exports = { ROLE_HIERARCHY, roleLevel, isValidRole, isStaff, isAdminOrSu, canManage, canViewUserData };