// 功能10：代码查重路由
// 挂在 /api/v1/plagiarism 下
//   GET /api/v1/plagiarism/pairs/:pair_id       查询单对详情（含代码与高亮 token）
//   GET /api/v1/plagiarism/:task_id             查询进度/结果
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getTask, getPairDetail } = require('../services/plagiarism');

const router = express.Router();

// 查询单对详情：并排代码 + 共享 token 集合（前端高亮）
// 必须放在 /:task_id 之前，避免被通配匹配
router.get('/pairs/:pair_id', requireAuth, requireRole('teacher'), (req, res) => {
  const pair = getPairDetail(parseInt(req.params.pair_id));
  if (!pair) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Plagiarism pair not found.' });
  }
  res.json(pair);
});

// 查询任务进度/结果（admin/teacher 可见）
router.get('/:task_id', requireAuth, requireRole('teacher'), (req, res) => {
  const task = getTask(parseInt(req.params.task_id));
  if (!task) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Plagiarism task not found.' });
  }
  res.json(task);
});

module.exports = router;
