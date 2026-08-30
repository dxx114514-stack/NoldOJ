const db = require('../database/db');
const config = require('../config/config');
const { prepareWorkDir, compile, runCode, cleanupWorkDir, loadLanguageConfig } = require('../sandbox/executor');

const ideQueue = [];
const IDE_QUEUE_LIMIT = 100;
let isRunning = false;

// D-I5: 错误/编译输出可能含服务器内部路径，落库前替换，避免泄露目录结构
function stripPaths(text, workDir) {
  if (!text) return text;
  let out = String(text);
  if (workDir) out = out.split(workDir).join('{sandbox}');
  return out;
}

async function processIdeQueue() {
  if (isRunning || ideQueue.length === 0) return;
  isRunning = true;
  const runId = ideQueue.shift();
  try {
    await executeIdeRun(runId);
  } catch (err) {
    console.error(`IDE run error for #${runId}:`, err);
    db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = ? WHERE id = ?").run(stripPaths(String(err.message || err || 'Unknown error')), runId);
  }
  isRunning = false;
  if (ideQueue.length > 0) {
    setImmediate(processIdeQueue);
  }
}

async function executeIdeRun(runId) {
  const run = db.prepare('SELECT * FROM ide_runs WHERE id = ?').get(runId);
  if (!run) return;

  db.prepare("UPDATE ide_runs SET status = 'compiling' WHERE id = ?").run(runId);

  const langConfig = loadLanguageConfig();
  const lang = langConfig[run.language];
  if (!lang) {
    db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = 'Language not found' WHERE id = ?").run(runId);
    return;
  }

  let workDir, srcFile, exeFile;
  try {
    const prepared = prepareWorkDir(run.language, run.source_code);
    workDir = prepared.workDir;
    srcFile = prepared.srcFile;
    exeFile = prepared.exeFile;

    const compileResult = compile(workDir, srcFile, exeFile, lang, prepared.isWindows);
    if (!compileResult.success) {
      const safeOut = stripPaths(compileResult.output, workDir);
      cleanupWorkDir(workDir);
      db.prepare("UPDATE ide_runs SET status = 'compile_error', compile_output = ? WHERE id = ?").run(safeOut, runId);
      return;
    }

    db.prepare("UPDATE ide_runs SET status = 'running' WHERE id = ?").run(runId);

    const timeLimitMs = config.ide.timeLimitMs;
    const result = await runCode(workDir, srcFile, exeFile, lang, run.stdin || '', timeLimitMs, config.ide.memoryLimitMb, prepared.isWindows, 'traditional');
    cleanupWorkDir(workDir);

    const finalStatus = result.exitCode === 0 ? 'accepted' : 'runtime_error';
    db.prepare("UPDATE ide_runs SET status = ?, stdout = ?, stderr = ?, exit_code = ?, time_used = ?, memory_used = ? WHERE id = ?").run(
      finalStatus, result.stdout, result.stderr, result.exitCode, result.timeUsed, result.memoryUsed || 0, runId
    );
  } catch (err) {
    if (workDir) cleanupWorkDir(workDir);
    db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = ? WHERE id = ?").run(stripPaths(String(err.message || err || 'Unknown error'), workDir), runId);
  }
}

function enqueueIdeRun(runId) {
  // R9-23: 队列有界——超过上限拒绝入队并标记错误，避免内存无限增长
  if (ideQueue.length >= IDE_QUEUE_LIMIT) {
    try {
      db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = 'Server queue is full, please retry later.' WHERE id = ?").run(runId);
    } catch {}
    return;
  }
  ideQueue.push(runId);
  setImmediate(processIdeQueue);
}

module.exports = { enqueueIdeRun };
