const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('sandbox');
const db = require('../database/db');
const sandbox = require('../sandbox/executor');
const { spawnSync } = require('node:child_process');

// 真实编译用例依赖 g++（MinGW）。没有编译器的环境（如未装 MinGW 的 CI 镜像）应跳过而非失败。
const gpp = spawnSync('g++', ['--version'], { shell: process.platform === 'win32', stdio: 'ignore' });
const SKIP_NO_GPP = gpp.status === 0 ? false : '未检测到 g++，跳过真实编译测试';

describe('C++ Sandbox & Executor Real Execution', () => {
  before(async () => {
    await db.initDB();
  });
  it('正确执行简单 C++ 程序并捕获标准输出与内存', { skip: SKIP_NO_GPP }, async () => {
    const code = `
      #include <iostream>
      using namespace std;
      int main() {
        int a, b;
        if (cin >> a >> b) {
          cout << (a + b) << endl;
        }
        return 0;
      }
    `;

    const prep = sandbox.prepareWorkDir('cpp', code);
    try {
      const compRes = sandbox.compile(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, prep.isWindows, false);
      assert.ok(compRes.success, `编译应当成功: ${compRes.output}`);

      const runRes = await sandbox.runCode(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, '123 456', 2000, 128, prep.isWindows, 'standard');
      assert.equal(runRes.exitCode, 0, '退出码应当为 0');
      assert.equal(runRes.stdout.trim(), '579', '标准输出应当为两数之和 579');
      assert.ok(runRes.timeUsed >= 0, '用时测量应当有效');
      assert.ok(runRes.memoryUsed >= 0, '内存测量应当有效');
    } finally {
      sandbox.cleanupWorkDir(prep.workDir);
    }
  });

  it('超时死循环程序能被沙箱严格限制并中断 (TLE 拦截)', { skip: SKIP_NO_GPP }, async () => {
    const loopCode = `
      #include <iostream>
      using namespace std;
      int main() {
        while(true) {}
        return 0;
      }
    `;

    const prep = sandbox.prepareWorkDir('cpp', loopCode);
    try {
      const compRes = sandbox.compile(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, prep.isWindows, false);
      assert.ok(compRes.success, '编译应当成功');

      const startTime = Date.now();
      const timeLimitMs = 600;
      const runRes = await sandbox.runCode(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, '', timeLimitMs, 64, prep.isWindows, 'standard');
      const elapsed = Date.now() - startTime;

      // 应当被沙箱在设定时限（加少量缓冲）附近杀死，并且 signal 为 SIGKILL 或超时标识
      assert.ok(runRes.signal === 'SIGKILL' || runRes.timeUsed >= timeLimitMs || elapsed >= timeLimitMs, '应当被判定为超时杀死');
      assert.ok(elapsed < 4000, `沙箱未能在合理时间内杀死超时进程，耗时 ${elapsed}ms`);
    } finally {
      sandbox.cleanupWorkDir(prep.workDir);
    }
  });

  it('语法错误代码编译失败并返回错误诊断', { skip: SKIP_NO_GPP }, () => {
    const badCode = `
      #include <iostream>
      int main() {
        this_is_a_syntax_error !@#$%^
      }
    `;

    const prep = sandbox.prepareWorkDir('cpp', badCode);
    try {
      const compRes = sandbox.compile(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, prep.isWindows, false);
      assert.equal(compRes.success, false, '语法错误代码编译应当失败');
      assert.ok(compRes.output.length > 0, '应当返回编译器报错信息');
    } finally {
      sandbox.cleanupWorkDir(prep.workDir);
    }
  });
});
