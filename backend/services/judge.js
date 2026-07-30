const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const sandbox = require('../sandbox/executor');
const { runScoringScript } = require('../sandbox/scorer');

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

function runSPJ(spjCode, expected, actual) {
  try {
    const result = eval(`(function(stdin, stdout, answer) { ${spjCode} })`)('', actual, expected);
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
  let workDir, srcFile, exeFile, isWindows;
  let compiled = false;

  const groups = db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
  const hasGroups = groups.length > 0;

  try {
    const prepared = sandbox.prepareWorkDir(submission.language, submission.source_code);
    workDir = prepared.workDir;
    srcFile = prepared.srcFile;
    exeFile = prepared.exeFile;
    isWindows = prepared.isWindows;

    const compileResult = sandbox.compile(workDir, srcFile, exeFile, lang, isWindows);
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
            const stdin = tc.input_data || (tc.input_file ? fs.readFileSync(tc.input_file, 'utf8') : '');
            const expected = tc.output_data || (tc.output_file ? fs.readFileSync(tc.output_file, 'utf8') : '');
            const tcTimeLimit = tc.time_limit || timeLimitMs;
            const tcMemLimit = tc.memory_limit || problem.memory_limit;
            const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows);

            const timeUsed = result.timeUsed;
            const passed = compareOutput(expected, result.stdout, problem);
            let status = passed ? 'accepted' : 'wrong_answer';
            if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
            else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
            else if (result.exitCode !== 0 && !passed) status = 'runtime_error';

            if (status !== 'accepted') groupAllAccepted = false;
            const memKB = result.memoryUsed || 0;
            updateDetail.run(status, 0, timeUsed, memKB, (result.stdout || '').slice(0, 4096), (result.stderr || '').slice(0, 4096), result.exitCode, '', detailId);
            tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, detailId });
          } catch (err) {
            groupAllAccepted = false;
            updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
            tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, detailId });
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
          const stdin = tc.input_data || (tc.input_file ? fs.readFileSync(tc.input_file, 'utf8') : '');
          const expected = tc.output_data || (tc.output_file ? fs.readFileSync(tc.output_file, 'utf8') : '');
          const tcTimeLimit = tc.time_limit || timeLimitMs;
          const tcMemLimit = tc.memory_limit || problem.memory_limit;
          const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows);

          const timeUsed = result.timeUsed;
          const passed = compareOutput(expected, result.stdout, problem);
          let status = passed ? 'accepted' : 'wrong_answer';
          if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
          else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
          else if (result.exitCode !== 0 && !passed) status = 'runtime_error';

          const memKB = result.memoryUsed || 0;
          updateDetail.run(status, 0, timeUsed, memKB, (result.stdout || '').slice(0, 4096), (result.stderr || '').slice(0, 4096), result.exitCode, '', detailId);
          tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, detailId });
        } catch (err) {
          updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
          tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, detailId });
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
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, '', '', 0, '', tc.detailId);
    }

    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
  } catch (err) {
    if (workDir && compiled) sandbox.cleanupWorkDir(workDir);
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

  while (pendingGroups.size > 0 && iterations < 100) {
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

  db.prepare("UPDATE submissions SET status = 'judging' WHERE id = ?").run(submissionId);

  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(submission.problem_id);
  if (!problem) {
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
    return;
  }

  const testCases = db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(submission.problem_id);
  if (testCases.length === 0) {
    db.prepare("UPDATE submissions SET status = 'accepted', score = 0 WHERE id = ?").run(submissionId);
    return;
  }

  const timeLimitMs = problem.time_limit;
  await evaluateTestCases(submission, submission.problem_id, testCases, timeLimitMs);

  try {
    const updated = db.prepare('SELECT status, score FROM submissions WHERE id = ?').get(submissionId);
    if (!updated) return;

    if (updated.status === 'compile_error') {
      db.prepare('UPDATE users SET rating = rating - 2 WHERE id = ?').run(submission.user_id);
    }

    if (updated.status === 'accepted') {
      const prevAccepted = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND problem_id = ? AND status = ? AND id < ?').get(
        submission.user_id, submission.problem_id, 'accepted', submissionId
      ).c;
      if (prevAccepted === 0) {
        db.prepare('UPDATE users SET rating = rating + 10 WHERE id = ?').run(submission.user_id);
      }
    }
  } catch {}
}

const judgeQueue = [];
const queuedIds = new Set();
let isJudging = false;

async function processQueue() {
  if (isJudging || judgeQueue.length === 0) return;
  isJudging = true;
  const submissionId = judgeQueue.shift();
  queuedIds.delete(submissionId);
  try {
    await judgeSubmission(submissionId);
  } catch (err) {
    console.error(`Judge error for submission ${submissionId}:`, err);
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
  }
  isJudging = false;
  if (judgeQueue.length > 0) {
    setImmediate(processQueue);
  }
}

function enqueueSubmission(submissionId) {
  if (queuedIds.has(submissionId)) return;
  queuedIds.add(submissionId);
  judgeQueue.push(submissionId);
  setImmediate(processQueue);
}

module.exports = { judgeSubmission, enqueueSubmission, compareOutput };
