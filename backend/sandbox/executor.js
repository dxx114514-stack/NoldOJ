const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const db = require('../database/db');

// ── 安全沙箱运行器 (sandbox_runner.exe) ─────────────────────
// 提供 Job Object + 受限令牌 + 低完整性级别 + 进程树隔离
// 缺失时 start.bat 会自动从 sandbox_runner.cpp 编译；编译失败才回退到传统模式
const SANDBOX_RUNNER_PATH = path.join(__dirname, 'sandbox_runner.exe');
const hasSandboxRunner = process.platform === 'win32' && fs.existsSync(SANDBOX_RUNNER_PATH);

const LANG_MAP = {
  c: { compile: 'gcc -O2 -Wall -o "{exe}" "{src}"', run: '"{exe}"', ext: '.c', runUnix: './{exe}', compiled: true },
  cpp: { compile: 'g++ -O2 -Wall -std=c++17 -o "{exe}" "{src}"', run: '"{exe}"', ext: '.cpp', runUnix: './{exe}', compiled: true },
  python3: { compile: '', run: 'python "{src}"', ext: '.py' },
  java: { compile: 'javac "{src}" -d "{workdir}"', run: 'java -cp "{workdir}" Main', ext: '.java', compiled: true },
  javascript: { compile: '', run: 'node "{src}"', ext: '.js' }
};

function loadLanguageConfig() {
  const rows = db.prepare('SELECT name, compile_cmd, run_cmd, extension FROM languages WHERE is_enabled = 1').all();
  const map = {};
  for (const row of rows) {
    const base = LANG_MAP[row.name] || {};
    map[row.name] = {
      compile: row.compile_cmd || base.compile || '',
      run: row.run_cmd || base.run || '',
      ext: row.extension || base.ext || '.txt',
      runUnix: base.runUnix,
      compiled: base.compiled || false
    };
  }
  return { ...LANG_MAP, ...map };
}

function prepareWorkDir(language, sourceCode) {
  const id = uuidv4();
  const workDir = path.join(config.sandbox.tempDir, id);
  fs.mkdirSync(workDir, { recursive: true });

  const langConfig = loadLanguageConfig();
  const lang = langConfig[language];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const srcFile = path.join(workDir, `Main${lang.ext}`);
  fs.writeFileSync(srcFile, sourceCode, 'utf8');

  const isWindows = process.platform === 'win32';
  const exeFile = path.join(workDir, 'Main');

  return { workDir, srcFile, exeFile, lang, isWindows };
}

// 多文件提交：将所有文件写入工作目录，返回主文件路径用于编译/运行
function prepareWorkDirMulti(language, files) {
  const id = uuidv4();
  const workDir = path.join(config.sandbox.tempDir, id);
  fs.mkdirSync(workDir, { recursive: true });

  const langConfig = loadLanguageConfig();
  const lang = langConfig[language];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files provided for multi-file submission');
  }
  // 限制单次提交文件数与总大小，防止磁盘耗尽
  const MAX_FILES = config.sandbox.maxFilesPerSubmission || 64;
  const MAX_TOTAL_BYTES = config.sandbox.maxSubmissionBytes || 1024 * 1024; // 默认 1MB
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files (max ${MAX_FILES})`);
  }
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += Buffer.byteLength(String(f.content || ''), 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Total source size exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
  }

  // 写入所有文件
  const sanitizeFile = (name) => {
    // Windows 保留设备名 (CON/NUL/PRN/AUX/COM1-9/LPT1-9/CONIN$/CONOUT$) 及其带扩展名形式不允许
    const base = String(name).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
    const stem = base.replace(/\.[^.]+$/, '').replace(/\$$/, '');
    const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin|conout)$/i;
    return RESERVED.test(stem) ? '_' + base : base;
  };
  const writtenNames = new Map(); // 原始名 → 净化后名
  for (const f of files) {
    const safeName = sanitizeFile(path.basename(f.filename)) || '_';
    writtenNames.set(path.basename(f.filename), safeName);
    const filePath = path.join(workDir, safeName);
    fs.writeFileSync(filePath, f.content, 'utf8');
  }

  // 确定主文件（用于运行入口）
  const defaultMain = defaultMainFilename(language);
  let mainFile = files.find(f => path.basename(f.filename).toLowerCase() === defaultMain.toLowerCase());
  if (!mainFile) mainFile = files[0];
  // D-L11: 用净化后的文件名定位主文件，确保与实际落盘路径一致，避免编译/运行定位失败
  const srcFile = path.join(workDir, writtenNames.get(path.basename(mainFile.filename)) || sanitizeFile(path.basename(mainFile.filename)));

  const isWindows = process.platform === 'win32';
  const exeFile = path.join(workDir, 'Main');

  return { workDir, srcFile, exeFile, lang, isWindows, isMultiFile: files.length > 1 };
}

function defaultMainFilename(language) {
  const map = { c: 'main.c', cpp: 'main.cpp', python3: 'main.py', java: 'Main.java', javascript: 'main.js' };
  return map[language] || 'main.txt';
}

function compile(workDir, srcFile, exeFile, lang, isWindows, isMultiFile) {
  if (!lang.compile) return { success: true, output: '' };

  const actualExe = isWindows ? exeFile + '.exe' : exeFile;

  try {
    return _doCompile(workDir, srcFile, exeFile, lang, isWindows, isMultiFile);
  } finally {
    // no sandbox cleanup needed
  }
}

function _doCompile(workDir, srcFile, exeFile, lang, isWindows, isMultiFile) {
  const actualExe = isWindows ? exeFile + '.exe' : exeFile;

  // 多文件 C++: 参数数组直传 spawnSync，不经 shell/token 化，杜绝参数注入。
  if (isMultiFile && lang.ext === '.cpp') {
    const extraSources = collectExtraSources(workDir, srcFile);
    const gppArgs = ['-O2', '-Wall', '-std=c++17', '-o', actualExe, ...extraSources, srcFile];
    try {
      const result = spawnSync('g++', gppArgs, {
        cwd: workDir, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true
      });
      if (result.status === 0) return { success: true, output: String(result.stdout || '') };
      return { success: false, output: String(result.stderr || result.stdout || errMsg(result)) };
    } catch (err) {
      return { success: false, output: String(err.message || 'Compilation failed') };
    }
  }

  let cmd = lang.compile;
  cmd = cmd
    .replace('{src}', srcFile)
    .replace('{exe}', actualExe)
    .replace('{workdir}', workDir);

  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
  const compiler = parts[0].replace(/^"|"$/g, '');
  const argTokens = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

  try {
    const result = spawnSync(compiler, argTokens, {
      cwd: workDir, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true
    });
    if (result.status === 0) {
      return { success: true, output: String(result.stdout || '') };
    }
    return { success: false, output: String(result.stderr || result.stdout || errMsg(result)) };
  } catch (err) {
    return { success: false, output: String(err.stderr || err.stdout || err.message || 'Compilation failed') };
  }
  function errMsg(result) { return 'Compilation failed (exit ' + (result.status ?? '?') + ')'; }
}

// 收集工作目录下的额外 .cpp 源文件。文件名必须为安全字符（无空白/引号/前导 -），
// 否则跳过，防止把上传文件名当作 gcc 编译选项注入。
function collectExtraSources(workDir, srcFile) {
  const candidates = [workDir, path.join(workDir, 'main')];
  const seen = new Set();
  const extraSources = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.cpp')) continue;
      const full = path.join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      // 主文件已作为 srcFile 单独传入，避免重复编译同一文件
      if (path.resolve(full) === path.resolve(srcFile)) continue;
      if (f.startsWith('-') || !/^[A-Za-z0-9_.-]+$/.test(f)) continue;
      extraSources.push(full);
    }
  }
  return extraSources;
}

function killProc(proc, isWindows) {
  try {
    if (isWindows && proc.pid) {
      // D-M12: taskkill 由 spawnSync 改为异步 spawn（fire-and-forget），
      // 消除超时杀进程时对事件循环的同步阻塞；进程树清理由 taskkill /T 完成。
      const killer = spawn('taskkill', ['/F', '/PID', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

// ── 安全沙箱模式: 使用 sandbox_runner.exe ───────────────────
// 流程: Node.js ↔ sandbox_runner.exe (Job Object + 受限令牌 + 低完整性级别) ↔ 子进程
// sandbox_runner.exe 负责: CREATE_SUSPENDED + Job 绑定 + 内存/时间监控 + 进程树清理 + Low IL
function runCodeSandboxed(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows) {
  return new Promise((resolve) => {
    const actualExe = isWindows ? exeFile + '.exe' : exeFile;
    const runCmd = (!isWindows && lang.runUnix) ? lang.runUnix : lang.run;
    const cmd = runCmd
      .replace('{src}', srcFile)
      .replace('{exe}', actualExe)
      .replace('{workdir}', workDir);

    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
    const execFile = parts[0].replace(/^"|"$/g, '');
    const execArgs = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

    const metaFile = path.join(workDir, '_meta.json');
    const maxProcs = config.sandbox.maxProcesses || 64;

    // sandbox_runner.exe <time_ms> <mem_mb> <max_proc> <meta_file> <exe> [args...]
    const runnerArgs = [
      String(timeLimitMs),
      String(memoryLimitMb),
      String(maxProcs),
      metaFile,
      execFile,
      ...execArgs
    ];

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(SANDBOX_RUNNER_PATH, runnerArgs, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    // 超时保险: 即使 sandbox_runner.exe 自身卡住也要杀掉
    const safetyTimer = setTimeout(() => {
      killed = true;
      killProc(proc, isWindows);
    }, timeLimitMs + 5000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > config.sandbox.maxOutputSize) {
        killed = true;
        killProc(proc, isWindows);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > config.sandbox.maxOutputSize) {
        killed = true;
        killProc(proc, isWindows);
      }
    });

    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();

    proc.on('close', (code) => {
      clearTimeout(safetyTimer);
      const timeUsed = Date.now() - startTime;

      // 读取元数据文件
      let meta = null;
      try {
        const metaRaw = fs.readFileSync(metaFile, 'utf8');
        meta = JSON.parse(metaRaw);
      } catch {}

      resolve({
        stdout,
        stderr,
        exitCode: meta ? meta.exit_code : (code !== null ? code : -1),
        timeUsed: meta ? meta.time_used : timeUsed,
        memoryUsed: meta ? meta.memory_used : 0,
        signal: meta ? (meta.signal === 'null' ? null : meta.signal) : (killed ? 'SIGKILL' : null)
      });
    });

    proc.on('error', (err) => {
      clearTimeout(safetyTimer);
      resolve({
        stdout,
        stderr: stderr + '\n' + (err.message || 'Process error'),
        exitCode: -1,
        timeUsed: Date.now() - startTime,
        memoryUsed: 0,
        signal: null
      });
    });
  });
}

// ── 传统模式: 直接 spawn (回退) ─────────────────────────────
function runCodeLegacy(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows) {
  return new Promise((resolve) => {
    const actualExe = isWindows ? exeFile + '.exe' : exeFile;
    const runCmd = (!isWindows && lang.runUnix) ? lang.runUnix : lang.run;
    const cmd = runCmd
      .replace('{src}', srcFile)
      .replace('{exe}', actualExe)
      .replace('{workdir}', workDir);

    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
    const execFile = parts[0].replace(/^"|"$/g, '');
    const execArgs = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

    const startTime = Date.now();
    let killed = false;
    let peakMemoryKB = 0;
    let memoryLimitKB = memoryLimitMb * 1024;

    const proc = spawn(execFile, execArgs, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > config.sandbox.maxOutputSize) {
        killed = true;
        killProc(proc, isWindows);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > config.sandbox.maxOutputSize) {
        killed = true;
        killProc(proc, isWindows);
      }
    });

    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();

    const timer = setTimeout(() => {
      killed = true;
      killProc(proc, isWindows);
    }, timeLimitMs);

    // 传统模式无 sandbox_runner.exe 做内存监控: Windows 上用 tasklist 轮询内存，
    // 一旦超过 memoryLimitMb 即终止进程，保证内存限制生效
    let memPollTimer = null;
    if (isWindows && memoryLimitKB > 0) {
      memPollTimer = setInterval(() => {
        try {
          if (!Number.isInteger(proc.pid) || proc.pid <= 0) return;
          // 参数数组形式，不经 shell 拼接，杜绝命令注入
          const memRes = spawnSync('tasklist', ['/FI', `PID eq ${proc.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
          const out = (memRes.stdout || '').trim().split('\n')[0] || '';
          const match = out.match(/,"([\d,.]+)\s*K"/);
          if (match) {
            const kb = Math.round(parseFloat(match[1].replace(/,/g, '')));
            if (kb > peakMemoryKB) peakMemoryKB = kb;
            if (peakMemoryKB > memoryLimitKB) {
              killed = true;
              killProc(proc, isWindows);
            }
          }
        } catch {}
      }, 150);
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (memPollTimer) clearInterval(memPollTimer);
      const timeUsed = Date.now() - startTime;
      const oom = memoryLimitKB > 0 && peakMemoryKB > memoryLimitKB;
      resolve({
        stdout,
        stderr,
        exitCode: code !== null ? code : -1,
        timeUsed,
        memoryUsed: peakMemoryKB,
        signal: killed ? (oom ? 'MEMORY_LIMIT' : 'SIGKILL') : null
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (memPollTimer) clearInterval(memPollTimer);
      resolve({
        stdout,
        stderr: stderr + '\n' + (err.message || 'Process error'),
        exitCode: -1,
        timeUsed: Date.now() - startTime,
        memoryUsed: peakMemoryKB,
        signal: null
      });
    });
  });
}

// ── 统一入口: 优先使用安全沙箱 ─────────────────────────────
// 传统模式以服务用户完整权限裸跑用户代码，无 Job/受限令牌/网络隔离。
// 默认保持回退兼容；显式设置 NoldOJ_REQUIRE_RUNNER=1 时缺 runner 即 fail-closed 拒绝判题。
const requireRunner = process.env.NoldOJ_REQUIRE_RUNNER === '1';
function runCode(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows) {
  if (hasSandboxRunner && isWindows) {
    return runCodeSandboxed(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows);
  }
  if (requireRunner) {
    return Promise.reject(new Error('安全沙箱运行器缺失（NoldOJ_REQUIRE_RUNNER=1 启用 fail-closed），已拒绝执行。请编译 sandbox_runner.exe 或关闭该开关。'));
  }
  return runCodeLegacy(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows);
}

function cleanupWorkDir(workDir) {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

// D-M13: 服务重启后回收上次崩溃遗留的孤儿进程与临时目录
// （上次运行崩溃/强杀时，spawn 的子进程可能残留继续占用 CPU/内存）。
// 仅回收命令行引用沙箱临时目录的进程，绝不误杀无关进程。
// D-L14/8.4.1: PowerShell 查询改为参数化——tempDir 经 stdin/环境变量传入，
// 避免直接把路径拼进脚本字符串，杜绝含单引号/通配符的路径破坏查询或误匹配。
function cleanupOrphanProcesses() {
  const tempDir = config.sandbox.tempDir;
  try {
    if (!fs.existsSync(tempDir)) return;
    const orphans = [];
    if (process.platform === 'win32') {
      // tempDir 通过环境变量注入，脚本内不拼接用户路径；匹配转义后的字面路径
      const escaped = tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const q =
        'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $env:NoldOJ_PARENT_PID -and $_.CommandLine -match $env:NoldOJ_TMP_ESC } | Select-Object -ExpandProperty ProcessId';
      const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', q], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, NoldOJ_PARENT_PID: String(process.pid), NoldOJ_TMP_ESC: escaped }
      });
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const pid = parseInt(line.trim(), 10);
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) orphans.push(pid);
        }
      }
      for (const pid of orphans) {
        spawn('taskkill', ['/F', '/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' }).unref();
      }
    } else {
      // 非 Windows: 由 Job Object/KILL_ON_JOB_CLOSE 兜底，这里仅清理临时目录
      spawnSync('pkill', ['-f', tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { stdio: 'ignore', timeout: 5000 });
    }
    // 清理遗留临时工作目录
    for (const entry of fs.readdirSync(tempDir)) {
      const full = path.join(tempDir, entry);
      try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
    if (orphans.length > 0) {
      console.log(`[ORPHAN] Killed ${orphans.length} orphaned sandbox process(es) from previous run`);
    }
  } catch (err) {
    // 清理失败不影响启动，仅记录
  }
}

module.exports = { prepareWorkDir, prepareWorkDirMulti, compile, runCode, cleanupWorkDir, loadLanguageConfig, cleanupOrphanProcesses };