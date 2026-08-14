const fs = require('fs');
const path = require('path');
const vm = require('vm');
const db = require('../database/db');
const sandbox = require('../sandbox/executor');
const config = require('../config/config');
const { runScoringScript } = require('../sandbox/scorer');
const { emitJudgeStatus, emitContestRanking } = require('./socket');
const { sanitizeLog } = require('../utils/securityHelpers');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const RATING_DELTA_COMPILE_ERROR = -2;
const RATING_DELTA_ACCEPTED = 10;
const MAX_OUTPUT_LOG_CHARS = 4096;
const SPJ_TIMEOUT_MS = 1000;
const MAX_GROUP_EVAL_ITERATIONS = 100;
const MAX_TESTDATA_BYTES = 16 * 1024 * 1024; // 16MB 单测试数据文件上限

function compareTextStrict(expected, actual) {
  return expected.trimEnd() === actual.trimEnd();
}

function compareTextRelaxed(expected, actual) {
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/ +/g, ' ').replace(/^ +| +$/gm, '').replace(/\n{2,}/g, '\n').trimEnd();
  return normalize(expected) === normalize(actual);
}

function compareRealNumber(expected, actual, tolerance) {
  const expectedLines = expected.trim().split(/\s+/);
  const actualLines = actual.trim().split(/\s+/);
  if (expectedLines.length !== actualLines.length) return false;
  for (let i = 0; i < expectedLines.length; i++) {
    const e = parseFloat(expectedLines[i]);
    const a = parseFloat(actualLines[i]);
    if (isNaN(e) || isNaN(a)) {
      if (expectedLines[i] !== actualLines[i]) return false;
      continue;
    }
    const absErr = Math.abs(e - a);
    const relErr = e !== 0 ? absErr / Math.abs(e) : absErr;
    if (absErr > tolerance.absolute && relErr > tolerance.relative) return false;
  }
  return true;
}

function compareOutput(expected, actual, problem) {
  const mode = problem.compare_mode;
  if (mode === 'text_strict') return compareTextStrict(expected, actual);
  if (mode === 'text_relaxed') return compareTextRelaxed(expected, actual);
  if (mode === 'real_number') {
    let tolerance = { absolute: 0.001, relative: 0.001 };
    try { tolerance = JSON.parse(problem.real_number_tolerance); } catch {}
    return compareRealNumber(expected, actual, tolerance);
  }
  if (mode === 'spj') return runSPJ(problem.spj_code, expected, actual);
  return compareTextStrict(expected, actual);
}

// 读取测试数据文件，限制单文件大小防止超大用例整读入内存导致 OOM
function readTestdata(filePath) {
  if (!filePath) return '';
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TESTDATA_BYTES) {
      throw new Error('Test data file exceeds 16MB limit');
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error('Failed to read test data: ' + err.message);
  }
}

// SPJ 执行: 使用 vm 沙箱隔离，剥离 require/process/fs 等危险全局对象
// 注意: vm 并非绝对安全的沙箱，但相比 eval 已杜绝直接访问主进程上下文
function runSPJ(spjCode, expected, actual) {
  try {
    // vm 逃逸防护: 若把宿主 realm 的字符串（stdout/answer）作为沙箱对象属性注入，
    // spjCode 可经 `stdout.constructor.constructor` 拿到宿主 Function 并执行任意代码。
    // 因此不注入任何宿主对象，只把数据序列化为 JSON 字符串字面量直接拼进脚本源码，
    // 使沙箱内的一切（包括全局对象、构造函数）都属于 vm 的独立 realm。
    const sandbox = vm.createContext({});
    const script = new vm.Script(`(function(stdin, stdout, answer) { ${spjCode} })(JSON.parse(${JSON.stringify(JSON.stringify(''))}), JSON.parse(${JSON.stringify(JSON.stringify(String(actual ?? '')))}), JSON.parse(${JSON.stringify(JSON.stringify(String(expected ?? '')))}))`);
    const result = script.runInContext(sandbox, { timeout: SPJ_TIMEOUT_MS });
    return result === true || result === 1 || result === 'AC';
  } catch {
    return false;
  }
}

function statusToConstant(status) {
  if (status === 'accepted') return 1;
  if (status === 'time_limit_exceeded') return 3;
  if (status === 'memory_limit_exceeded') return 4;
  if (status === 'skipped') return 0;
  return 2;
}

async function evaluateTestCases(submission, problemId, testCases, timeLimitMs) {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
  if (!problem) return;

  const updateDetail = db.prepare(`UPDATE submission_details SET status=?, score=?, time_used=?, memory_used=?, stdout=?, stderr=?, exit_code=?, checker_output=? WHERE id=?`);
  const updateSubmission = db.prepare(`UPDATE submissions SET status=?, score=?, time_used=?, memory_used=?, compile_output=? WHERE id=?`);
  const insertDetail = db.prepare('INSERT INTO submission_details (submission_id, test_case_id, group_id, subtask_id, status) VALUES (?, ?, ?, ?, ?)');

  const langConfig = sandbox.loadLanguageConfig();
  const lang = langConfig[submission.language] || { compile: '', run: '', ext: '.txt' };
  let workDir, srcFile, exeFile, isWindows, isMultiFile = false;
  let compiled = false;

  const groups = db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
  const hasGroups = groups.length > 0;

  // 检查是否有多文件记录
  const subFiles = db.prepare('SELECT filename, content FROM submission_files WHERE submission_id = ? ORDER BY id').all(submission.id);

  // submit_answer 题型：无需编译运行，直接比较提交的 answer_data 与预期输出
  if (problem.problem_type === 'submit_answer') {
    const tcResults = [];
    for (const tc of testCases) {
      const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
      const detailId = detail.lastInsertRowid;
      let expected = tc.output_data || '';
      try {
        expected = tc.output_data || readTestdata(tc.output_file);
      } catch (err) {
        updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: err.message, exitCode: -1, detailId });
        continue;
      }
      const answer = submission.answer_data || '';
      const passed = compareOutput(expected, answer, problem);
      const status = passed ? 'accepted' : 'wrong_answer';
      updateDetail.run(status, 0, 0, 0, answer.slice(0, MAX_OUTPUT_LOG_CHARS), '', 0, '', detailId);
      tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed: 0, memoryUsed: 0, stdout: answer.slice(0, MAX_OUTPUT_LOG_CHARS), stderr: '', exitCode: 0, detailId });
    }

    let finalScore, finalStatus, finalTime, finalMemory;
    if (hasGroups) {
      const result = evaluateWithGroups(problem, groups, tcResults);
      finalScore = result.score; finalStatus = result.status; finalTime = result.time; finalMemory = result.memory;
    } else {
      const result = evaluateSimple(problem, tcResults);
      finalScore = result.score; finalStatus = result.status; finalTime = result.time; finalMemory = result.memory;
    }
    for (const tc of tcResults) {
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, '', tc.detailId);
    }
    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
    return;
  }

  try {
    let prepared;
    if (subFiles && subFiles.length > 0) {
      prepared = sandbox.prepareWorkDirMulti(submission.language, subFiles);
      isMultiFile = prepared.isMultiFile;
    } else {
      prepared = sandbox.prepareWorkDir(submission.language, submission.source_code);
    }
    workDir = prepared.workDir;
    srcFile = prepared.srcFile;
    exeFile = prepared.exeFile;
    isWindows = prepared.isWindows;

    const compileResult = sandbox.compile(workDir, srcFile, exeFile, lang, isWindows, isMultiFile);
    if (!compileResult.success) {
      const detail = insertDetail.run(submission.id, null, null, '', 'running');
      updateDetail.run('compile_error', 0, 0, 0, '', compileResult.output, -1, '', detail.lastInsertRowid);
      updateSubmission.run('compile_error', 0, 0, 0, compileResult.output, submission.id);
      sandbox.cleanupWorkDir(workDir);
      return;
    }
    compiled = true;

    const tcResults = [];

    if (hasGroups) {
      const tcMap = new Map();
      for (const tc of testCases) {
        if (!tcMap.has(tc.group_id || 0)) tcMap.set(tc.group_id || 0, []);
        tcMap.get(tc.group_id || 0).push(tc);
      }

      const failedGroups = new Set();
      const topoOrder = topoSortGroups(groups);

      for (const groupId of topoOrder) {
        const group = groups.find(g => g.id === groupId);
        let deps = [];
        try { deps = JSON.parse(group.dependency || '[]'); } catch {}

        const depFailed = deps.some(d => failedGroups.has(d));

        if (depFailed) {
          const groupTCs = tcMap.get(groupId) || [];
          for (const tc of groupTCs) {
            const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'skipped');
            const detailId = detail.lastInsertRowid;
            updateDetail.run('skipped', 0, 0, 0, '', '', -1, '', detailId);
            tcResults.push({
              tcId: tc.id,
              groupId: tc.group_id,
              subtaskId: tc.subtask_id || '',
              status: 'skipped',
              score: 0,
              timeUsed: 0,
              memoryUsed: 0,
              stdout: '',
              stderr: '',
              exitCode: -1,
              detailId
            });
          }
          failedGroups.add(groupId);
          continue;
        }

        const groupTCs = tcMap.get(groupId) || [];
        let groupAllAccepted = true;

        for (const tc of groupTCs) {
          const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
          const detailId = detail.lastInsertRowid;

          try {
const stdin = tc.input_data || readTestdata(tc.input_file);
            const expected = tc.output_data || readTestdata(tc.output_file);
            const tcTimeLimit = tc.time_limit || timeLimitMs;
            const tcMemLimit = tc.memory_limit || problem.memory_limit;
            const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows);

            const timeUsed = result.timeUsed;
            const passed = compareOutput(expected, result.stdout, problem);
let status = passed ? 'accepted' : 'wrong_answer';
          if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
          else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
          else if (result.exitCode !== 0) status = 'runtime_error';

          if (status !== 'accepted') groupAllAccepted = false;
            const memKB = result.memoryUsed || 0;
            updateDetail.run(status, 0, timeUsed, memKB, (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS), (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS), result.exitCode, '', detailId);
            tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, stdout: (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS), stderr: (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS), exitCode: result.exitCode, detailId });
          } catch (err) {
            groupAllAccepted = false;
            updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
            tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: err.message, exitCode: -1, detailId });
          }
        }

        if (!groupAllAccepted) {
          failedGroups.add(groupId);
        }
      }
    } else {
      for (const tc of testCases) {
        const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
        const detailId = detail.lastInsertRowid;

        try {
          const stdin = tc.input_data || readTestdata(tc.input_file);
          const expected = tc.output_data || readTestdata(tc.output_file);
          const tcTimeLimit = tc.time_limit || timeLimitMs;
          const tcMemLimit = tc.memory_limit || problem.memory_limit;
          const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows);

          const timeUsed = result.timeUsed;
          const passed = compareOutput(expected, result.stdout, problem);
          let status = passed ? 'accepted' : 'wrong_answer';
          if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
          else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
          else if (result.exitCode !== 0) status = 'runtime_error';

          const memKB = result.memoryUsed || 0;
          updateDetail.run(status, 0, timeUsed, memKB, (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS), (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS), result.exitCode, '', detailId);
          tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, stdout: (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS), stderr: (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS), exitCode: result.exitCode, detailId });
        } catch (err) {
          updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
          tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: err.message, exitCode: -1, detailId });
        }
      }
    }

    if (workDir) sandbox.cleanupWorkDir(workDir);

    let finalScore, finalStatus, finalTime, finalMemory;

    if (hasGroups) {
      const result = evaluateWithGroups(problem, groups, tcResults);
      finalScore = result.score;
      finalStatus = result.status;
      finalTime = result.time;
      finalMemory = result.memory;
    } else {
      const result = evaluateSimple(problem, tcResults);
      finalScore = result.score;
      finalStatus = result.status;
      finalTime = result.time;
      finalMemory = result.memory;
    }

    for (const tc of tcResults) {
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, '', tc.detailId);
    }

    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
  } catch (err) {
    // 无论编译/判题是否深入，只要建过 workDir 就清理，避免临时文件残留
    if (workDir) sandbox.cleanupWorkDir(workDir);
    updateSubmission.run('system_error', 0, 0, 0, err.message, submission.id);
  }
}

function topoSortGroups(groups) {
  const groupMap = {};
  for (const g of groups) groupMap[g.id] = g;

  const validIds = new Set(Object.keys(groupMap).map(Number));

  const visited = new Set();
  const visiting = new Set();
  const order = [];

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const g = groupMap[id];
    if (g) {
      let deps = [];
      try { deps = JSON.parse(g.dependency || '[]'); } catch {}
      for (const d of deps) {
        if (validIds.has(Number(d))) visit(d);
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const g of groups) visit(g.id);
  return order;
}

function evaluateSimple(problem, tcResults) {
  const hasScript = problem.scoring_script && problem.scoring_script.trim();

  if (!hasScript) {
    let totalScore = 0, maxTime = 0, maxMem = 0, allPassed = true;
    for (const tc of tcResults) {
      totalScore += tc.score;
      maxTime = Math.max(maxTime, tc.timeUsed);
      maxMem = Math.max(maxMem, tc.memoryUsed);
      if (tc.status !== 'accepted') allPassed = false;
    }
    return {
      score: allPassed ? totalScore : tcResults.filter(t => t.status === 'accepted').reduce((s, t) => s + t.score, 0),
      status: allPassed ? 'accepted' : (maxTime > 0 && tcResults.some(t => t.status === 'time_limit_exceeded') ? 'time_limit_exceeded' : 'wrong_answer'),
      time: maxTime,
      memory: maxMem
    };
  }

  const context = {};
  for (const tc of tcResults) {
    context[`@status${tc.tcId}`] = statusToConstant(tc.status);
    context[`@score${tc.tcId}`] = tc.score;
    context[`@time${tc.tcId}`] = tc.timeUsed;
    context[`@memory${tc.tcId}`] = tc.memoryUsed;
  }

  context['@total_score'] = 0;
  context['@final_status'] = 2;
  context['@final_time'] = 0;
  context['@final_memory'] = 0;

  const result = runScoringScript(problem.scoring_script, context);

  return {
    score: result.total_score,
    status: result.final_status,
    time: result.final_time,
    memory: result.final_memory
  };
}

function evaluateWithGroups(problem, groups, tcResults) {
  const tcsByGroup = {};
  for (const tc of tcResults) {
    const gid = tc.groupId || 0;
    if (!tcsByGroup[gid]) tcsByGroup[gid] = [];
    tcsByGroup[gid].push(tc);
  }

  const groupResults = {};
  const completedGroups = new Set();

  const pendingGroups = new Set(groups.map(g => g.id));
  let iterations = 0;

  while (pendingGroups.size > 0 && iterations < MAX_GROUP_EVAL_ITERATIONS) {
    iterations++;
    let madeProgress = false;

    for (const group of groups) {
      if (!pendingGroups.has(group.id)) continue;

      let deps = [];
      try { deps = JSON.parse(group.dependency || '[]'); } catch {}
      const depsMet = deps.every(d => completedGroups.has(d));

      if (!depsMet) continue;

      pendingGroups.delete(group.id);

      const groupTCs = tcsByGroup[group.id] || [];
      const hasScript = group.scoring_script && group.scoring_script.trim();

      const allSkipped = groupTCs.length > 0 && groupTCs.every(tc => tc.status === 'skipped');

      if (allSkipped) {
        groupResults[group.id] = {
          score: 0,
          status: 'skipped',
          time: 0,
          memory: 0,
          maxScore: group.score
        };
        completedGroups.add(group.id);
        madeProgress = true;
        continue;
      }

      if (hasScript) {
        const context = {};
        for (const tc of groupTCs) {
          context[`@status${tc.tcId}`] = statusToConstant(tc.status);
          context[`@score${tc.tcId}`] = tc.score;
          context[`@time${tc.tcId}`] = tc.timeUsed;
          context[`@memory${tc.tcId}`] = tc.memoryUsed;
        }

        context['@total_score'] = 0;
        context['@final_status'] = 2;
        context['@final_time'] = 0;
        context['@final_memory'] = 0;

        const result = runScoringScript(group.scoring_script, context);
        groupResults[group.id] = {
          score: result.total_score,
          status: result.final_status,
          time: result.final_time,
          memory: result.final_memory,
          maxScore: group.score
        };
      } else {
        let score = 0, maxTime = 0, maxMem = 0, allPassed = true, allSkipped = true;
        for (const tc of groupTCs) {
          if (tc.status !== 'skipped') allSkipped = false;
          score += tc.score;
          maxTime = Math.max(maxTime, tc.timeUsed);
          maxMem = Math.max(maxMem, tc.memoryUsed);
          if (tc.status !== 'accepted') allPassed = false;
        }
        groupResults[group.id] = {
          score: allPassed ? score : 0,
          status: allSkipped ? 'skipped' : (allPassed ? 'accepted' : 'wrong_answer'),
          time: maxTime,
          memory: maxMem,
          maxScore: group.score
        };
      }

      // Keep individual test case scores for display
      // Final score is calculated from group results, not individual test case scores

      completedGroups.add(group.id);
      madeProgress = true;
    }

    if (!madeProgress) break;
  }

  for (const gid of pendingGroups) {
    groupResults[gid] = { score: 0, status: 'system_error', time: 0, memory: 0, maxScore: 0 };
  }

  const hasProblemScript = problem.scoring_script && problem.scoring_script.trim();

  if (hasProblemScript) {
    const context = {};
    for (const [gid, gr] of Object.entries(groupResults)) {
      context[`@status${gid}`] = statusToConstant(gr.status);
      context[`@score${gid}`] = gr.score;
      context[`@time${gid}`] = gr.time;
      context[`@memory${gid}`] = gr.memory;
    }
    context['@total_score'] = 0;
    context['@final_status'] = 2;
    context['@final_time'] = 0;
    context['@final_memory'] = 0;

    const result = runScoringScript(problem.scoring_script, context);
    return { score: result.total_score, status: result.final_status, time: result.final_time, memory: result.final_memory };
  }

  let totalScore = 0, maxTime = 0, maxMem = 0, allPassed = true;
  for (const gid of Object.keys(groupResults)) {
    const gr = groupResults[gid];
    totalScore += gr.score;
    maxTime = Math.max(maxTime, gr.time);
    maxMem = Math.max(maxMem, gr.memory);
    if (gr.status !== 'accepted') allPassed = false;
  }

  return {
    score: totalScore,
    status: allPassed ? 'accepted' : 'wrong_answer',
    time: maxTime,
    memory: maxMem
  };
}

async function judgeSubmission(submissionId) {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!submission) return;

  // 记录判题前的状态，用于评分发放去重（rejudge 场景）
  const wasAccepted = submission.status === 'accepted';
  const wasCompileError = submission.status === 'compile_error';

  db.prepare("UPDATE submissions SET status = 'judging' WHERE id = ?").run(submissionId);
  emitJudgeStatus(submissionId, submission.user_id, 'judging');

  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(submission.problem_id);
  if (!problem) {
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
    emitJudgeStatus(submissionId, submission.user_id, 'system_error');
    return;
  }

  const testCases = db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(submission.problem_id);
  if (testCases.length === 0) {
    db.prepare("UPDATE submissions SET status = 'accepted', score = 0 WHERE id = ?").run(submissionId);
    emitJudgeStatus(submissionId, submission.user_id, 'accepted');
    return;
  }

  const timeLimitMs = problem.time_limit;
  await evaluateTestCases(submission, submission.problem_id, testCases, timeLimitMs);

  try {
    const updated = db.prepare('SELECT status, score FROM submissions WHERE id = ?').get(submissionId);
    if (!updated) return;

    // 推送最终评测状态
    emitJudgeStatus(submissionId, submission.user_id, updated.status);

    if (updated.status === 'compile_error' && !wasCompileError) {
      db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?').run(RATING_DELTA_COMPILE_ERROR, submission.user_id);
    }

    if (updated.status === 'accepted') {
      const prevAccepted = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND problem_id = ? AND status = ? AND id < ?').get(
        submission.user_id, submission.problem_id, 'accepted', submissionId
      ).c;
      // 提交本身此前已 AC（rejudge 场景）或已有更早 AC 记录时不再重复发放 Rating
      const firstAccepted = !wasAccepted && prevAccepted === 0;
      if (firstAccepted) {
        db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?').run(RATING_DELTA_ACCEPTED, submission.user_id);
      }
      // 推送比赛排行榜更新（若该题目属于某比赛）
      const contestProblem = db.prepare('SELECT cp.contest_id FROM contest_problems cp WHERE cp.problem_id = ?').get(submission.problem_id);
      if (contestProblem) {
        emitContestRanking(contestProblem.contest_id, {
          user_id: submission.user_id,
          submission_id: submissionId,
          problem_id: submission.problem_id,
          status: 'accepted'
        });
      }
      // 自动更新题单进度（功能7）：将该题所在的题单中标记为已解决
      try {
        const sets = db.prepare('SELECT DISTINCT set_id FROM problem_set_items WHERE problem_id = ?').all(submission.problem_id);
        if (sets.length > 0) {
          const upsert = db.prepare(`
            INSERT INTO problem_set_progress (user_id, set_id, problem_id, solved, solved_at)
            VALUES (?, ?, ?, 1, datetime('now'))
            ON CONFLICT(user_id, set_id, problem_id) DO UPDATE SET solved = 1, solved_at = datetime('now')
          `);
          for (const s of sets) upsert.run(submission.user_id, s.set_id, submission.problem_id);
        }
      } catch {}
    }
  } catch {}
}

const judgeQueue = [];
const queuedIds = new Set();
const maxThreads = config.judge.maxThreads;
const runningJobs = new Set();

// 并发判题池：最多同时运行 maxThreads 条提交，各自独立判题线程
async function runOne(submissionId) {
  try {
    await judgeSubmission(submissionId);
  } catch (err) {
    console.error(`Judge error for submission ${submissionId}:`, sanitizeLog(String(err && err.message || err)));
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
  }
}

function pumpQueue() {
  while (runningJobs.size < maxThreads && judgeQueue.length > 0) {
    const submissionId = judgeQueue.shift();
    queuedIds.delete(submissionId);
    const job = runOne(submissionId);
    runningJobs.add(job);
    job.finally(() => {
      runningJobs.delete(job);
      pumpQueue();
    });
  }
}

function enqueueSubmission(submissionId) {
  if (queuedIds.has(submissionId)) return;
  queuedIds.add(submissionId);
  judgeQueue.push(submissionId);
  pumpQueue();
}

// 服务重启后恢复中断的判题任务（内存队列随进程死亡而丢失，需重置中断态重新入队）
function recoverInterruptedSubmissions() {
  const rows = db.prepare("SELECT id FROM submissions WHERE status IN ('pending','pending_rejudge','running','compiling','judging')").all();
  for (const r of rows) {
    try { db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(r.id); } catch {}
    enqueueSubmission(r.id);
  }
  return rows.length;
}

module.exports = { judgeSubmission, enqueueSubmission, compareOutput, recoverInterruptedSubmissions };
