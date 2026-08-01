// sandbox_runner.cpp
// WinOJ 安全沙箱运行器 — 基于 Windows Job Object + 受限令牌
//
// 安全特性:
//   1. CREATE_SUSPENDED 创建进程，绑定 Job 后再 ResumeThread，杜绝竞态逃逸
//   2. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — Job 关闭则整棵进程树被系统秒杀
//   3. 禁用 BREAKAWAY — 子进程无法脱离沙箱
//   4. JOB_OBJECT_LIMIT_ACTIVE_PROCESS — 限制进程树最大进程数
//   5. CreateRestrictedToken — 剥离 SeDebugPrivilege / SeImpersonatePrivilege 等高危特权
//   6. 内存限制 — Job Object process_memory_limit + 轮询双重保障
//   7. CPU 时间限制 — Job Object per-job user time limit + 轮询
//
// 编译: g++ -O2 -static -o sandbox_runner.exe sandbox_runner.cpp
// 用法: sandbox_runner.exe <time_limit_ms> <memory_limit_mb> <max_processes> <meta_file> <exe_path> [args...]
// stdout/stderr: 子进程的直接透传
// meta_file: 评测结束后写入 JSON 元数据

#include <windows.h>
#include <psapi.h>
#include <stdio.h>
#include <string>
#include <vector>

#pragma comment(lib, "psapi.lib")

// ── 创建受限令牌: 剥离高危特权 ─────────────────────────────
static HANDLE createRestrictedToken() {
    HANDLE hCurrentToken = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &hCurrentToken))
        return NULL;

    std::vector<LUID> denyLuids;
    const char* privNames[] = {
        SE_DEBUG_NAME, SE_IMPERSONATE_NAME, SE_ASSIGNPRIMARYTOKEN_NAME,
        SE_TCB_NAME, SE_LOAD_DRIVER_NAME, SE_BACKUP_NAME,
        SE_RESTORE_NAME, SE_SECURITY_NAME, SE_TAKE_OWNERSHIP_NAME,
        SE_MANAGE_VOLUME_NAME, SE_CREATE_PAGEFILE_NAME,
    };
    for (const char* name : privNames) {
        LUID luid;
        if (LookupPrivilegeValueA(NULL, name, &luid))
            denyLuids.push_back(luid);
    }

    std::vector<LUID_AND_ATTRIBUTES> privsToDelete;
    for (const auto& luid : denyLuids)
        privsToDelete.push_back({ luid, 0 });

    HANDLE hRestricted = NULL;
    BOOL ok = CreateRestrictedToken(
        hCurrentToken, 0,
        0, NULL,
        (DWORD)privsToDelete.size(), privsToDelete.data(),
        0, NULL,
        &hRestricted
    );
    CloseHandle(hCurrentToken);
    return ok ? hRestricted : NULL;
}

// ── 创建 Job Object 并设置安全限制 ─────────────────────────
static HANDLE createJob(DWORD timeLimitMs, SIZE_T memLimitBytes, DWORD maxProcs) {
    HANDLE hJob = CreateJobObjectA(NULL, NULL);
    if (!hJob) return NULL;

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {};
    jeli.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    // 绝对不设置 JOB_OBJECT_LIMIT_BREAKAWAY_OK / SILENT_BREAKAWAY_OK

    jeli.BasicLimitInformation.ActiveProcessLimit = maxProcs;

    if (timeLimitMs > 0)
        jeli.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = (ULONGLONG)timeLimitMs * 10000;

    if (memLimitBytes > 0) {
        jeli.ProcessMemoryLimit = memLimitBytes;
        jeli.JobMemoryLimit = memLimitBytes;
        jeli.BasicLimitInformation.LimitFlags |=
            JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
    }

    if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        CloseHandle(hJob);
        return NULL;
    }
    return hJob;
}

// ── 查询 Job 峰值内存 (KB) ─────────────────────────────────
static SIZE_T getJobPeakMemKB(HANDLE hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
    DWORD retLen = 0;
    if (QueryInformationJobObject(hJob, JobObjectExtendedLimitInformation, &info, sizeof(info), &retLen))
        return info.PeakProcessMemoryUsed / 1024;
    return 0;
}

// ── 写元数据 JSON 到文件 ──────────────────────────────────
static void writeMeta(const char* path, int exitCode, DWORD timeMs, SIZE_T memKB, const char* signal) {
    FILE* f = fopen(path, "w");
    if (!f) return;
    fprintf(f, "{\"exit_code\":%d,\"time_used\":%lu,\"memory_used\":%llu,\"signal\":\"%s\"}",
            exitCode, (unsigned long)timeMs, (unsigned long long)memKB, signal);
    fclose(f);
}

// ── 主函数 ─────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    if (argc < 6) {
        fprintf(stderr, "Usage: sandbox_runner.exe <time_ms> <mem_mb> <max_proc> <meta_file> <exe> [args...]\n");
        return 1;
    }

    DWORD timeLimitMs   = (DWORD)atoll(argv[1]);
    SIZE_T memLimitBytes = (SIZE_T)atoll(argv[2]) * 1024 * 1024;
    DWORD maxProcs      = (DWORD)atoll(argv[3]);
    const char* metaFile = argv[4];
    const char* exePath  = argv[5];

    // 构建命令行
    std::string cmdLine;
    for (int i = 5; i < argc; i++) {
        if (i > 5) cmdLine += " ";
        cmdLine += "\"";
        cmdLine += argv[i];
        cmdLine += "\"";
    }
    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');

    // 1. 创建 Job Object
    HANDLE hJob = createJob(timeLimitMs, memLimitBytes, maxProcs);
    if (!hJob) {
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        fprintf(stderr, "[sandbox] Failed to create Job Object\n");
        return 1;
    }

    // 2. 创建受限令牌
    HANDLE hRestricted = createRestrictedToken();

    // 3. CREATE_SUSPENDED 创建子进程 (继承 stdio 句柄)
    STARTUPINFOA si = {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi = {};
    SECURITY_ATTRIBUTES sa = {};
    sa.bInheritHandle = TRUE;

    DWORD flags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
    BOOL ok;
    if (hRestricted) {
        ok = CreateProcessAsUserA(hRestricted, NULL, cmdBuf.data(), &sa, &sa, TRUE, flags, NULL, NULL, &si, &pi);
    } else {
        ok = CreateProcessA(NULL, cmdBuf.data(), &sa, &sa, TRUE, flags, NULL, NULL, &si, &pi);
    }

    if (!ok) {
        DWORD err = GetLastError();
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        fprintf(stderr, "[sandbox] CreateProcess failed (error %lu)\n", err);
        CloseHandle(hJob);
        if (hRestricted) CloseHandle(hRestricted);
        return 1;
    }

    // 4. 绑定到 Job Object (进程仍挂起)
    if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1);
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        fprintf(stderr, "[sandbox] AssignProcessToJobObject failed\n");
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(hJob);
        if (hRestricted) CloseHandle(hRestricted);
        return 1;
    }

    // 5. 唤醒主线程 — 进程开始执行
    ResumeThread(pi.hThread);

    // 6. 轮询等待: 每 50ms 检查内存和时间
    DWORD startTime = GetTickCount();
    SIZE_T peakMemKB = 0;
    SIZE_T memLimitKB = memLimitBytes / 1024;
    bool oom = false, timeout = false;

    while (true) {
        DWORD waitResult = WaitForSingleObject(pi.hProcess, 50);
        if (waitResult == WAIT_OBJECT_0) break; // 进程已退出

        peakMemKB = getJobPeakMemKB(hJob);
        if (memLimitKB > 0 && peakMemKB > memLimitKB) {
            oom = true;
            break;
        }
        DWORD elapsed = GetTickCount() - startTime;
        if (timeLimitMs > 0 && elapsed >= timeLimitMs) {
            timeout = true;
            break;
        }
    }

    DWORD timeUsed = GetTickCount() - startTime;

    // 终止进程 (如果是超时或 OOM)
    if (oom || timeout) {
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 500);
    }

    // 获取最终峰值内存和退出码
    peakMemKB = getJobPeakMemKB(hJob);
    if (peakMemKB == 0) {
        PROCESS_MEMORY_COUNTERS pmc;
        if (GetProcessMemoryInfo(pi.hProcess, &pmc, sizeof(pmc)))
            peakMemKB = pmc.PeakWorkingSetSize / 1024;
    }

    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    const char* signal = "null";
    if (oom) signal = "MEMORY_LIMIT";
    else if (timeout) signal = "SIGKILL";

    // 7. 写元数据
    writeMeta(metaFile, (int)exitCode, timeUsed, peakMemKB, signal);

    // 8. 清理 — 关闭 Job 触发 KILL_ON_JOB_CLOSE，杀掉所有残留子进程
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hJob);
    if (hRestricted) CloseHandle(hRestricted);

    return 0;
}
