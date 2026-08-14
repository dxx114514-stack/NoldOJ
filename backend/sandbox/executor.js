const { execSync, spawn, exec, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const db = require('../database/db');

// ── 安全沙箱运行器 (sandbox_runner.exe) ─────────────────────
// 当存在时优先使用，提供 Job Object + 受限令牌 + 进程树隔离
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
    // Windows 保留设备名 (CON/NUL/PRN/AUX/COM1-9/LPT1-9) 及其带扩展名形式不允许
    const base = String(name).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
    const stem = base.replace(/\.[^.]+$/, '');
    const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    return RESERVED.test(stem) ? '_' + base : base;
  };
  for (const f of files) {
    const safeName = sanitizeFile(path.basename(f.filename)) || '_';
    const filePath = path.join(workDir, safeName);
    fs.writeFileSync(filePath, f.content, 'utf8');
  }

  // 确定主文件（用于运行入口）
  const defaultMain = defaultMainFilename(language);
  let mainFile = files.find(f => path.basename(f.filename).toLowerCase() === defaultMain.toLowerCase());
  if (!mainFile) mainFile = files[0];
  const srcFile = path.join(workDir, path.basename(mainFile.filename));

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
  let cmd = lang.compile;

  // 多文件 C++: 显式收集 main 目录下所有 .cpp（不经 shell 通配符，避免注入）
  let extraSources = [];
  if (isMultiFile && lang.ext === '.cpp') {
    const mainDir = path.join(workDir, 'main');
    extraSources = fs.readdirSync(mainDir).filter(f => f.endsWith('.cpp')).map(f => path.join(mainDir, f));
    cmd = 'g++ -O2 -Wall -std=c++17 -o "{exe}" {extra} "{src}"';
  }

  cmd = cmd
    .replace('{src}', srcFile)
    .replace('{exe}', actualExe)
    .replace('{workdir}', workDir)
    .replace('{extra}', extraSources.join(' '));

  // 解析为可执行文件 + 参数数组，使用 spawnSync 不经 shell，杜绝命令注入
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
  const compiler = parts[0].replace(/^"|"$/g, '');
  const argTokens = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

  try {
    const result = spawnSync(compiler, argTokens, {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    if (result.status === 0) {
      return { success: true, output: String(result.stdout || '') };
    }
    return { success: false, output: String(result.stderr || result.stdout || errMsg()) };
  } catch (err) {
    return { success: false, output: String(err.stderr || err.stdout || err.message || 'Compilation failed') };
  }
  function errMsg() { return 'Compilation failed (exit ' + (result.status ?? '?') + ')'; }
}

function killProc(proc, isWindows) {
  try {
    if (isWindows && proc.pid) {
      // 不经 shell 拼接，避免 PID/路径注入（spawnSync 参数数组形式）
      spawnSync('taskkill', ['/F', '/PID', String(proc.pid), '/T'], { windowsHide: true, timeout: 5000 });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

// ── 安全沙箱模式: 使用 sandbox_runner.exe ───────────────────
// 流程: Node.js ↔ sandbox_runner.exe (Job Object 容器) ↔ 子进程
// sandbox_runner.exe 负责: CREATE_SUSPENDED + Job 绑定 + 内存/时间监控 + 进程树清理
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

    // 元数据临时文件
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
function runCode(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows) {
  if (hasSandboxRunner && isWindows) {
    return runCodeSandboxed(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows);
  }
  return runCodeLegacy(workDir, srcFile, exeFile, lang, stdin, timeLimitMs, memoryLimitMb, isWindows);
}

function cleanupWorkDir(workDir) {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

module.exports = { prepareWorkDir, prepareWorkDirMulti, compile, runCode, cleanupWorkDir, loadLanguageConfig };
