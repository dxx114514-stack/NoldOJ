const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const db = require('../database/db');
const sandbox = require('../sandbox/executor');
const config = require('../config/config');
const { runScoringScript } = require('../sandbox/scorer');
const { emitJudgeStatus, emitContestRanking } = require('./socket');
const { checkAchievements } = require('./achievements');
const examProgram = require('./examProgram');
const { sanitizeLog } = require('../utils/securityHelpers');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const RATING_DELTA_COMPILE_ERROR = -2;
const RATING_DELTA_ACCEPTED = 10;
const MAX_OUTPUT_LOG_CHARS = 4096;
const SPJ_TIMEOUT_MS = 1000;
const MAX_GROUP_EVAL_ITERATIONS = 100;
const MAX_TESTDATA_BYTES = 16 * 1024 * 1024; // 16MB 单测试数据文件上限
// D-M11: 测试点资源硬上限兜底（教师可配置任意值 → 服务端强制封顶，防判题线程被独占）
const MAX_TL_MS = 10000;     // 单测试点 ≤10s
// problem.memory_limit / test_cases.memory_limit 全链路存的是 **MB**
// （executor: memoryLimitMb*1024→KB；sandbox_runner: *1024*1024→bytes；前端默认 256、显示 "MB"）。
// 原先这里写成 1024*1024 并命名为 _KB，等于把封顶放到 1TB —— 形同虚设，
// 而且会成为"MLE 漏判"的根因之一：内存限制被放到天量后 Job Object 永不触发 OOM。
const MAX_ML_MB = 1024; // 单测试点 ≤1024MB

// D-M11: 服务端硬上限钳制（TLE≤10s、MLE≤1024MB）
function clampLimits(tl, ml) {
  const t = Number(tl) > 0 ? Number(tl) : null;
  const m = Number(ml) > 0 ? Number(ml) : null;
  return {
    tl: t === null ? null : Math.min(t, MAX_TL_MS),
    ml: m === null ? null : Math.min(m, MAX_ML_MB)
  };
}

// D-I5: 编译/判题错误信息可能含服务器内部路径，落库前用占位符替换，避免泄露目录结构
function stripInternalPaths(text, workDir) {
  if (!text) return text;
  let out = String(text);
  if (workDir) out = out.split(workDir).join('{sandbox}');
  return out;
}

function compareTextStrict(expected, actual) {
  // Windows 下 C/C++(MSVC 文本模式)、Java 输出 CRLF，Python/Node 输出 LF；
  // 而期望文件的换行风格取决于数据来源（AI 生成已归一化为 LF，ZIP/.out 上传则原样落盘）。
  // trimEnd() 只去字符串最末尾，行中间的 \r 去不掉，必须先统一分隔符，
  // 否则同一份数据无法同时满足各语言（整题全 WA）。
  const normalize = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  return normalize(expected) === normalize(actual);
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

// 比较器三态结果：ok=判定通过；!ok=判定不通过（该算学生的错）；
// checkerError=比较器自身故障（SPJ 抛错/超时/输出无法解析、容差配置非法）。
// 后者绝不能落成"答案错误"，否则教师写错的 SPJ 会让全站提交静默变 WA 且无从排查。
function compareOutputSync(expected, actual, problem) {
  const mode = problem.compare_mode;
  if (mode === 'text_relaxed') return { ok: compareTextRelaxed(expected, actual), checkerError: null };
  if (mode === 'real_number') {
    let tolerance = { absolute: 0.001, relative: 0.001 };
    if (problem.real_number_tolerance !== undefined && problem.real_number_tolerance !== null && problem.real_number_tolerance !== '') {
      try { tolerance = JSON.parse(problem.real_number_tolerance); } catch {
        return { ok: false, checkerError: 'real_number_tolerance 不是合法 JSON，无法比对。' };
      }
      const a = Number(tolerance && tolerance.absolute);
      const r = Number(tolerance && tolerance.relative);
      if (!isFinite(a) || !isFinite(r) || a < 0 || r < 0) {
        return { ok: false, checkerError: 'real_number_tolerance 结构非法，无法比对。' };
      }
      tolerance = { absolute: a, relative: r };
    }
    return { ok: compareRealNumber(expected, actual, tolerance), checkerError: null };
  }
  return { ok: compareTextStrict(expected, actual), checkerError: null };
}

async function compareOutputEx(expected, actual, problem) {
  if (problem.compare_mode === 'spj') {
    const r = await runSPJEx(problem.spj_code, expected, actual);
    if (r.error) return { ok: false, checkerError: r.error };
    return { ok: r.pass, checkerError: null };
  }
  return compareOutputSync(expected, actual, problem);
}

// 对外保持原签名：非 SPJ 模式同步返回布尔（现有单测与调用方依赖这一点），SPJ 返回 Promise
function compareOutput(expected, actual, problem) {
  if (problem.compare_mode === 'spj') {
    return compareOutputEx(expected, actual, problem).then(r => r.ok);
  }
  return compareOutputSync(expected, actual, problem).ok;
}

// 读取测试数据文件，限制单文件大小防止超大用例整读入内存导致 OOM。
// 路径包含校验：测试数据只允许位于 backend/../problems/ 目录内（判题进程以 backend 为 CWD）。
// 允许绝对路径（上传/zip 路由落库形式，path.join(problemDir,…)），但解析后必须仍在 problemsRoot 内；
// 相对路径（导入路由落库的 safeFileName 纯文件名）以 problemDir（problems/<id>/）为基准解析，
// 与导出侧 resolveFilePath 的基准一致（9.4），保证"仅有 input_file 且指向问题子目录相对路径"的用例可读。
// 拒绝越出 problemsRoot 的 .. 穿越，杜绝教师导入 output_file:"../../config/jwt.txt" 等任意文件读取（D-H2）。
const PROBLEMS_ROOT = config.problemsDir;
function readTestdata(filePath, problemDir) {
  if (!filePath) return '';
  const problemsRoot = path.resolve(PROBLEMS_ROOT);
  const base = problemDir ? path.resolve(problemDir) : problemsRoot;
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(base, filePath);
  if (resolved !== problemsRoot && !resolved.startsWith(problemsRoot + path.sep)) {
    throw new Error('Invalid test data path (outside problems directory)');
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_TESTDATA_BYTES) {
      throw new Error('Test data file exceeds 16MB limit');
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error('Failed to read test data: ' + err.message, { cause: err });
  }
}

// SPJ 执行: 改为子进程模式，彻底消除主进程事件循环阻塞与 vm 逃逸（D-H3/D-M10）。
// 原实现在判题进程内同步 vm.runInContext: 长 SPJ 会卡死单线程事件循环；
// 且 vm 逃逸可触及宿主 realm。现改为 spawn 独立 node 子进程（进程级隔离），
// 子进程内再套一层 vm + JSON 字面量注入保持 realm 隔离，超时/输出超限即 kill。
function runSPJEx(spjCode, expected, actual) {
  return new Promise((resolve) => {
    let tmpDir = null;
    let settled = false;
    let timer = null;
    const finish = (pass, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve({ pass: !!pass, error: error || null });
    };

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'NoldOJ-spj-'));
      const dataFile = path.join(tmpDir, 'data.json');
      const wrapperFile = path.join(tmpDir, 'spj.js');

      // vm 逃逸防护沿用原方案: 不注入任何宿主对象，数据序列化为 JSON 字符串字面量
      // 拼进脚本源码，使沙箱内的一切（含构造函数）都属于 vm 的独立 realm。
      // 构造方式: 先对参数做 JSON 编码（stdinJson 等为 JSON 文本），再用 JSON.stringify
      // 把该文本包成 JS 字符串字面量传给 JSON.parse，避免嵌套引号双重转义错误。
      const stdinJson = JSON.stringify('');
      const stdoutJson = JSON.stringify(String(actual ?? ''));
      const answerJson = JSON.stringify(String(expected ?? ''));
      const mkArg = (j) => 'JSON.parse(' + JSON.stringify(j) + ')';
      const argsSrc = [mkArg(stdinJson), mkArg(stdoutJson), mkArg(answerJson)].join(', ');

      const wrapper = [
        'const vm = require("vm");',
        'const fs = require("fs");',
        `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)}, "utf8"));`,
        'const sandbox = vm.createContext({});',
        `const vmSrc = "(function(stdin, stdout, answer) { " + data.spj + " })(" + ${JSON.stringify(argsSrc)} + ")";`,
        'const script = new vm.Script(vmSrc);',
        'try {',
        `  const result = script.runInContext(sandbox, { timeout: ${SPJ_TIMEOUT_MS} });`,
        '  process.stdout.write(JSON.stringify({ ok: true, pass: (result === true || result === 1 || result === "AC") }));',
        '} catch (e) {',
        '  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));',
        '}'
      ].join('\n');
      fs.writeFileSync(wrapperFile, wrapper, 'utf8');
      fs.writeFileSync(dataFile, JSON.stringify({ spj: String(spjCode ?? '') }), 'utf8');

      const proc = spawn(process.execPath, [wrapperFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let out = '';
      proc.stdout.on('data', (d) => {
        out += d.toString();
        if (out.length > 65536) { try { proc.kill('SIGKILL'); } catch {} }
      });

      // 硬超时: 独立 kill 子进程，不阻塞事件循环
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(false, 'SPJ 超时未返回结果');
      }, SPJ_TIMEOUT_MS + 1000);

      proc.on('error', () => finish(false, 'SPJ 进程启动失败'));
      proc.on('close', () => {
        const raw = out.trim().split('\n').pop() || '';
        try {
          const j = JSON.parse(raw);
          if (!j || !j.ok) {
            finish(false, 'SPJ 执行出错: ' + String((j && j.error) || 'unknown'));
          } else {
            finish(!!j.pass, null);
          }
        } catch {
          finish(false, 'SPJ 输出无法解析: ' + raw.slice(0, 200));
        }
      });
    } catch (e) {
      finish(false, 'SPJ 执行异常: ' + String((e && e.message) || e));
    }
  });
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

  // 9.4: 相对路径 testdata 以本题目目录为基准（与导出侧 resolveFilePath 一致）
  const problemDir = path.join(PROBLEMS_ROOT, String(problemId));

  const updateDetail = db.prepare(`UPDATE submission_details SET status=?, score=?, time_used=?, memory_used=?, stdout=?, stderr=?, exit_code=?, checker_output=? WHERE id=?`);
  const updateSubmission = db.prepare(`UPDATE submissions SET status=?, score=?, time_used=?, memory_used=?, compile_output=? WHERE id=?`);
  const insertDetail = db.prepare('INSERT INTO submission_details (submission_id, test_case_id, group_id, subtask_id, status) VALUES (?, ?, ?, ?, ?)');

  const langConfig = sandbox.loadLanguageConfig();
  const lang = langConfig[submission.language] || { compile: '', run: '', ext: '.txt' };
  let workDir, srcFile, exeFile, isWindows, isMultiFile = false;

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
      let expected;
      try {
        expected = tc.output_data || readTestdata(tc.output_file, problemDir);
      } catch (err) {
        updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: err.message, exitCode: -1, detailId });
        continue;
      }
      const answer = submission.answer_data || '';
      const cmp = await compareOutputEx(expected, answer, problem);
      // 比较器故障（容差配置非法 / SPJ 出错）不得记成学生的"答案错误"
      const status = cmp.ok ? 'accepted' : (cmp.checkerError ? 'system_error' : 'wrong_answer');
      const checkerError = cmp.checkerError || '';
      updateDetail.run(status, 0, 0, 0, answer.slice(0, MAX_OUTPUT_LOG_CHARS), '', 0, checkerError.slice(0, MAX_OUTPUT_LOG_CHARS), detailId);
      tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed: 0, memoryUsed: 0, stdout: answer.slice(0, MAX_OUTPUT_LOG_CHARS), stderr: '', exitCode: 0, detailId, checkerOutput: checkerError });
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
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, tc.checkerOutput || '', tc.detailId);
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
      const safeOutput = stripInternalPaths(compileResult.output, workDir);
      const detail = insertDetail.run(submission.id, null, null, '', 'running');
      updateDetail.run('compile_error', 0, 0, 0, '', safeOutput, -1, '', detail.lastInsertRowid);
      updateSubmission.run('compile_error', 0, 0, 0, safeOutput, submission.id);
      sandbox.cleanupWorkDir(workDir);
      return;
    }

    const tcResults = [];

    // 单个测试点的执行与结果落库（分组 / 未分组 / 无分组三种路径共用）
    // 返回该测试点是否 accepted
    const runOneTestCase = async (tc) => {
      const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
      const detailId = detail.lastInsertRowid;
      try {
        const stdin = tc.input_data || readTestdata(tc.input_file, problemDir);
        const expected = tc.output_data || readTestdata(tc.output_file, problemDir);
        const { tl: tcTimeLimit, ml: tcMemLimit } = clampLimits(tc.time_limit || timeLimitMs, tc.memory_limit || problem.memory_limit);
        const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows, problem.problem_type);

        const timeUsed = result.timeUsed;
        const cmp = await compareOutputEx(expected, result.stdout, problem);
        const passed = cmp.ok;
        const checkerError = cmp.checkerError || '';
        let status = passed ? 'accepted' : 'wrong_answer';
        if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
        // 输出超限是独立状态: 若并入 SIGKILL 分支会被误报成 TLE
        else if (result.signal === 'OUTPUT_LIMIT') status = passed ? 'accepted' : 'wrong_answer';
        else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
        else if (result.exitCode !== 0) status = 'runtime_error';
        // 比较器自身故障只能归为 system_error；放在最后表示仅在"其它原因都解释不了"时兜底
        else if (checkerError) status = 'system_error';

        const memKB = result.memoryUsed || 0;
        const logOut = (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS);
        const logErr = (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS);
        updateDetail.run(status, 0, timeUsed, memKB, logOut, logErr, result.exitCode, checkerError.slice(0, MAX_OUTPUT_LOG_CHARS), detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, stdout: logOut, stderr: logErr, exitCode: result.exitCode, detailId, checkerOutput: checkerError });
        return status === 'accepted';
      } catch (err) {
        const msg = stripInternalPaths(err.message, workDir);
        updateDetail.run('system_error', 0, 0, 0, '', msg, -1, '', detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: msg, exitCode: -1, detailId });
        return false;
      }
    };

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
          if (!(await runOneTestCase(tc))) groupAllAccepted = false;
        }

        if (!groupAllAccepted) {
          failedGroups.add(groupId);
        }
      }

      // 未分组测试点（group_id IS NULL → 聚到 key 0）不属于任何 test_group，
      // 上面的 topoOrder 遍历永远命不中。routes/problems.js 删除分组时会执行
      // `UPDATE test_cases SET group_id = NULL`，新增测试点时若不选分组同样落到 key 0。
      // 若不执行，这些点既不跑也没有详情、更不计分 —— 学生只做剩余分组即可拿满分。
      const ungroupedTCs = tcMap.get(0) || [];
      for (const tc of ungroupedTCs) {
        await runOneTestCase(tc);
      }
    } else {
      for (const tc of testCases) {
        await runOneTestCase(tc);
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
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, tc.checkerOutput || '', tc.detailId);
    }

    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
  } catch (err) {
    // 无论编译/判题是否深入，只要建过 workDir 就清理，避免临时文件残留
    if (workDir) sandbox.cleanupWorkDir(workDir);
    updateSubmission.run('system_error', 0, 0, 0, stripInternalPaths(err.message, workDir), submission.id);
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

// 提交/分组级状态归并。原先只会产出 accepted / time_limit_exceeded / wrong_answer，
// 导致测试点的 runtime_error、memory_limit_exceeded、system_error 全被降级成
// "答案错误"——教师误删 .out 时学生会看到 WA 而不是 system_error。
// skipped 是依赖跳过，不参与失败状态选择。
const FAILURE_STATUS_ORDER = ['system_error', 'memory_limit_exceeded', 'time_limit_exceeded', 'runtime_error', 'wrong_answer'];
function aggregateFailureStatus(items) {
  for (const s of FAILURE_STATUS_ORDER) {
    if (items.some(x => x.status === s)) return s;
  }
  return 'wrong_answer';
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
      status: allPassed ? 'accepted' : aggregateFailureStatus(tcResults),
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
          status: allSkipped ? 'skipped' : (allPassed ? 'accepted' : aggregateFailureStatus(groupTCs)),
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

  // 未分组测试点（group_id 为空 → key 0）不属于任何 test_group，上面的遍历覆盖不到，
  // 必须单独归并，否则它们被实际执行了却不参与总分与状态判定。
  const ungroupedTCs = tcsByGroup[0] || [];
  let ungroupedResult = null;
  if (ungroupedTCs.length > 0) {
    const passed = ungroupedTCs.filter(t => t.status === 'accepted');
    const allUngroupedPassed = passed.length === ungroupedTCs.length;
    ungroupedResult = {
      score: allUngroupedPassed
        ? ungroupedTCs.reduce((s, t) => s + t.score, 0)
        : passed.reduce((s, t) => s + t.score, 0),
      status: allUngroupedPassed ? 'accepted' : aggregateFailureStatus(ungroupedTCs),
      time: ungroupedTCs.reduce((m, t) => Math.max(m, t.timeUsed), 0),
      memory: ungroupedTCs.reduce((m, t) => Math.max(m, t.memoryUsed), 0)
    };
  }

  if (hasProblemScript) {
    const context = {};
    for (const [gid, gr] of Object.entries(groupResults)) {
      context[`@status${gid}`] = statusToConstant(gr.status);
      context[`@score${gid}`] = gr.score;
      context[`@time${gid}`] = gr.time;
      context[`@memory${gid}`] = gr.memory;
    }
    // 未分组测试点以 0 号"组"暴露（test_groups.id 从 1 自增，不会冲突）
    if (ungroupedResult) {
      context['@status0'] = statusToConstant(ungroupedResult.status);
      context['@score0'] = ungroupedResult.score;
      context['@time0'] = ungroupedResult.time;
      context['@memory0'] = ungroupedResult.memory;
    }
    context['@total_score'] = 0;
    context['@final_status'] = 2;
    context['@final_time'] = 0;
    context['@final_memory'] = 0;

    const result = runScoringScript(problem.scoring_script, context);
    return { score: result.total_score, status: result.final_status, time: result.final_time, memory: result.final_memory };
  }

  const allResults = Object.values(groupResults);
  if (ungroupedResult) allResults.push(ungroupedResult);

  let totalScore = 0, maxTime = 0, maxMem = 0, allPassed = true;
  for (const gr of allResults) {
    totalScore += gr.score;
    maxTime = Math.max(maxTime, gr.time);
    maxMem = Math.max(maxMem, gr.memory);
    if (gr.status !== 'accepted') allPassed = false;
  }

  return {
    score: totalScore,
    status: allPassed ? 'accepted' : aggregateFailureStatus(allResults),
    time: maxTime,
    memory: maxMem
  };
}

async function judgeSubmission(submissionId) {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!submission) return;

  // 记录判题前的状态，用于评分发放去重（rejudge 场景：路由层已把状态改为 pending_rejudge，
  // 原始状态需经 rejudgePrevStatus 传入，否则 wasAccepted/wasCompileError 恒为 false）
  const prevStatus = rejudgePrevStatus.get(submissionId) || submission.status;
  const wasAccepted = prevStatus === 'accepted';
  const wasCompileError = prevStatus === 'compile_error';

  db.prepare("UPDATE submissions SET status = 'judging' WHERE id = ?").run(submissionId);
  emitJudgeStatus(submissionId, submission.user_id, 'judging');
  // 每轮判题都从空白详情开始：rejudge 可能发生在上一轮尚未结束时，
  // 若不清理会出现"状态已更新但残留上一轮详情"或重复详情行。
  try { db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submissionId); } catch {}

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
    // 试卷编程题防御性回填（正常路径下考试题必有测试点，见 exams.js 校验）
    if (problem.exam_id) {
      try { examProgram.writeBackAfterJudge(submissionId); } catch (e) {
        console.error(`[JUDGE] 试卷答题回填失败 (submission ${submissionId}): ${e && e.message}`);
      }
    }
    return;
  }

  const timeLimitMs = problem.time_limit;
  await evaluateTestCases(submission, submission.problem_id, testCases, timeLimitMs);

  try {
    const updated = db.prepare('SELECT status, score FROM submissions WHERE id = ?').get(submissionId);
    if (!updated) return;

    // 推送最终评测状态
    emitJudgeStatus(submissionId, submission.user_id, updated.status);

    // 试卷编程题：回填 exam_answers 折算分并重算试卷提交总分（状态同步为 graded）
    if (problem.exam_id) {
      try {
        examProgram.writeBackAfterJudge(submissionId);
      } catch (e) {
        console.error(`[JUDGE] 试卷答题回填失败 (submission ${submissionId}): ${e && e.message}`);
      }
      // 考试提交完全隔离：不计成就、不发 Rating、不进比赛榜单与题单进度
      return;
    }

    // 成就检查（每次评测结束触发，含非 AC，用于连续做题天数的累计）
    try {
      checkAchievements(submission.user_id, submission.problem_id, submission.language, updated.created_at || submission.created_at);
    } catch (e) {
      console.warn(`[JUDGE] 成就检查失败 (submission ${submissionId}): ${e && e.message}`);
    }

    if (updated.status === 'compile_error' && !wasCompileError) {
      db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?').run(RATING_DELTA_COMPILE_ERROR, submission.user_id);
    }

    if (updated.status === 'accepted') {
      // R9-12/R10-1: 首 AC 加分竞态——同 (user,problem) 两提交并发判题时，双方都查不到
      // 对方已 AC（都未落库），会双双 +10；且新提交 first_accepted 默认 0，若仅按
      // first_accepted=0 判断则重复 AC 也会再次 +10（可无限刷分）。改为原子占位：
      // 仅当该 (user,problem) 尚无任何 first_accepted=1 时才标记并发放 Rating。
      const claimed = db.prepare(`
        UPDATE submissions SET first_accepted = 1
        WHERE user_id = ? AND problem_id = ? AND status = 'accepted' AND first_accepted = 0
          AND NOT EXISTS (
            SELECT 1 FROM submissions
            WHERE user_id = ? AND problem_id = ? AND first_accepted = 1
          )
      `).run(submission.user_id, submission.problem_id, submission.user_id, submission.problem_id);
      const firstAccepted = claimed.changes > 0 && !wasAccepted;
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
      } catch (e) {
        console.warn(`[JUDGE] 题单进度更新失败 (submission ${submissionId}): ${e && e.message}`);
      }
    }
  } catch (e) {
    // 评测后处理（推送/加分/榜单/题单）失败不能吞掉：它直接表现为"判完但分数没动"
    console.error(`[JUDGE] 评测后处理失败 (submission ${submissionId}): ${e && e.message}`);
  }
}

const judgeQueue = [];
const queuedIds = new Set();
const runningIds = new Set(); // 正在判题的提交，防 rejudge 对运行中任务重复入队（D-M1）
const maxThreads = config.judge.maxThreads;
const runningJobs = new Set();

// rejudge 任务入队时记录原始状态（在路由层已被改为 pending_rejudge，无法回读），
// 供评分发放去重判断（wasAccepted/wasCompileError）
const rejudgePrevStatus = new Map();
// 判题进行中收到的 rejudge 请求：等当前这一轮结束后必须再跑一次
const rejudgeRequested = new Set();

// 并发判题池：最多同时运行 maxThreads 条提交，各自独立判题线程
async function runOne(submissionId) {
  try {
    await judgeSubmission(submissionId);
  } catch (err) {
    console.error(`Judge error for submission ${submissionId}:`, sanitizeLog(String(err && err.message || err)));
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
  } finally {
    // 本轮判题期间若又收到 rejudge 请求（路由层已清空详情、置 pending_rejudge），
    // 必须重新入队，否则该次 rejudge 会静默丢失，提交停留在"已判完但没有测试点详情"的中间态。
    const again = rejudgeRequested.delete(submissionId);
    // 再次入队时保留 prevStatus 供下一轮使用；否则本轮结束后清掉
    if (!again) rejudgePrevStatus.delete(submissionId);
    runningIds.delete(submissionId);
    if (again) {
      queuedIds.add(submissionId);
      judgeQueue.push(submissionId);
    }
  }
}

function pumpQueue() {
  while (runningJobs.size < maxThreads && judgeQueue.length > 0) {
    const submissionId = judgeQueue.shift();
    queuedIds.delete(submissionId);
    runningIds.add(submissionId);
    const job = runOne(submissionId);
    runningJobs.add(job);
    // runOne 内部已 catch，这里只回收槽位；单独 catch 是为了避免 .finally() 派生的
    // Promise 变成 unhandledRejection → server.js 直接 process.exit(1)
    job.then(() => {}, () => {}).finally(() => {
      runningJobs.delete(job);
      pumpQueue();
    });
  }
}

function enqueueSubmission(submissionId, prevStatus) {
  // prevStatus 必须在任何早退之前落表：否则"正在排队/正在判题"时被丢弃，
  // judgeSubmission 会读到 pending_rejudge → wasCompileError=false → CE 重复扣 Rating
  if (prevStatus) rejudgePrevStatus.set(submissionId, prevStatus);
  if (runningIds.has(submissionId)) {
    rejudgeRequested.add(submissionId);
    return;
  }
  if (queuedIds.has(submissionId)) return;
  queuedIds.add(submissionId);
  judgeQueue.push(submissionId);
  pumpQueue();
}

// 服务重启后恢复中断的判题任务（内存队列随进程死亡而丢失，需重置中断态重新入队）
// R9-4: 纳入 pending_review——AI 安全审查属建议性（正常路径是放行后重新判题），
// 若进程在审查窗口内崩溃重启，该行必须重新入队判题，否则提交锁让该用户永久无法再提交。
function recoverInterruptedSubmissions() {
  const rows = db.prepare("SELECT id FROM submissions WHERE status IN ('pending','pending_review','pending_rejudge','running','compiling','judging')").all();
  for (const r of rows) {
    try { db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(r.id); } catch {}
    enqueueSubmission(r.id);
  }
  return rows.length;
}

module.exports = { judgeSubmission, enqueueSubmission, compareOutput, compareOutputEx, recoverInterruptedSubmissions };

