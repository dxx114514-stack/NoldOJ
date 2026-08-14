const db = require('../database/db');
const config = require('../config/config');
const { prepareWorkDir, compile, runCode, cleanupWorkDir, loadLanguageConfig } = require('../sandbox/executor');

const ideQueue = [];
let isRunning = false;

async function processIdeQueue() {
  if (isRunning || ideQueue.length === 0) return;
  isRunning = true;
  const runId = ideQueue.shift();
  try {
    await executeIdeRun(runId);
  } catch (err) {
    console.error(`IDE run error for #${runId}:`, err);
    db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = ? WHERE id = ?").run(String(err.message || err || 'Unknown error'), runId);
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
      cleanupWorkDir(workDir);
      db.prepare("UPDATE ide_runs SET status = 'compile_error', compile_output = ? WHERE id = ?").run(compileResult.output, runId);
      return;
    }

    db.prepare("UPDATE ide_runs SET status = 'running' WHERE id = ?").run(runId);

    const timeLimitMs = config.ide.timeLimitMs;
    const result = await runCode(workDir, srcFile, exeFile, lang, run.stdin || '', timeLimitMs, config.ide.memoryLimitMb, prepared.isWindows);
    cleanupWorkDir(workDir);

    const finalStatus = result.exitCode === 0 ? 'accepted' : 'runtime_error';
    db.prepare("UPDATE ide_runs SET status = ?, stdout = ?, stderr = ?, exit_code = ?, time_used = ?, memory_used = ? WHERE id = ?").run(
      finalStatus, result.stdout, result.stderr, result.exitCode, result.timeUsed, result.memoryUsed || 0, runId
    );
  } catch (err) {
    if (workDir) cleanupWorkDir(workDir);
    db.prepare("UPDATE ide_runs SET status = 'system_error', stderr = ? WHERE id = ?").run(String(err.message || err || 'Unknown error'), runId);
  }
}

function enqueueIdeRun(runId) {
  ideQueue.push(runId);
  setImmediate(processIdeQueue);
}

module.exports = { enqueueIdeRun };
