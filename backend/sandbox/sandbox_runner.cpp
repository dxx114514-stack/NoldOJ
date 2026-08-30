// sandbox_runner.cpp
// NoldOJ 安全沙箱运行器 — 基于 Windows Job Object + 受限令牌 + 低完整性级别 + AppContainer
//
// 安全特性:
//   1. CREATE_SUSPENDED 创建进程，绑定 Job 后再 ResumeThread，杜绝竞态逃逸
//   2. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — Job 关闭则整棵进程树被系统秒杀
//   3. 禁用 BREAKAWAY — 子进程无法脱离沙箱
//   4. JOB_OBJECT_LIMIT_ACTIVE_PROCESS — 限制进程树最大进程数
//   5. CreateRestrictedToken — 剥离 SeDebugPrivilege / SeImpersonatePrivilege 等高危特权
//   6. 内存限制 — Job Object process_memory_limit + 轮询双重保障
//   7. CPU 时间限制 — Job Object per-job user time limit + 轮询
//   8. 低完整性级别 — 禁止向高完整性对象写入
//   9. AppContainer — 文件系统 + 网络 隔离（详见下）
//
// ── AppContainer 文件系统隔离 ──────────────────────────────
// 以 AppContainer 令牌创建子进程后，子进程的访问检查只认"包 SID"，
// 用户的 SID / 组 不再参与 → 默认连包目录以外的文件都无法读取。
// 同时默认无法联网（未授予 internetClient 能力）。
//
// 因此每次评测必须显式授权：
//   - workDir 及其祖先目录：授予 FILE_TRAVERSE / 读 / 写 / 执行
//   - 解释器（python/node/java 等，运行文件不在 workDir 内时）：
//     授予其所在目录树的 读 + 执行
// 评测结束后把这些 ACE 全部撤销，避免在系统目录堆积死 ACL。
//
// 激活条件：调用进程需持有 SeAssignPrimaryTokenPrivilege（以管理员或服务身份启动）。
// 容器令牌在独立子进程中构建：某些系统上 CreateAppContainerToken 会访问违例崩溃，
// 崩溃只影响该子进程，父进程安全回退到受限令牌，不影响判题流程与输出捕获。
// 普通用户运行时跳过 AppContainer（该特权不存在），改为受限令牌：
//   - 禁用 Administrators / Backup Operators 等特权组
//   - 剥离 SeDebugPrivilege / SeImpersonatePrivilege 等高危特权
// 同用户受限令牌在普通用户下即可用 CreateProcessAsUser 启动子进程（已验证），
// 因此不必再"裸奔"回退到纯 CreateProcessA；仅当上述路径全部失败时才退化。
// 设环境变量 WINOJ_NO_APPCONTAINER=1 可完全禁用容器路径。
//
// 诊断日志：所有 [sandbox] 消息追加写入 <项目根>/log/sandbox.log
//（路径取 WINOJ_ROOT，未设置时按 exe 位置推导），同时输出到 stderr。
// 隔离粒度：每次评测派生独立的包 SID，题与题之间互不可见。
//
// 编译: g++ -O2 -static -o sandbox_runner.exe sandbox_runner.cpp -lpsapi -luserenv
// 用法: sandbox_runner.exe <time_limit_ms> <memory_limit_mb> <max_processes> <meta_file> <exe> [args...]
// stdout/stderr: 子进程的直接透传
// meta_file: 评测结束后写入 JSON 元数据

#define WINVER 0x0602
#define _WIN32_WINNT 0x0602
#define NTDDI_VERSION 0x06020000
#include <windows.h>
#include <psapi.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "userenv.lib")

// ── 沙箱诊断日志：追加写入 <项目根>/log/sandbox.log ────────
// 路径由本 exe 位置推导（backend/sandbox/… → 上两级即项目根），
// 与调用方 cwd 无关，保证无论从哪启动都能写入固定日志文件。
// 仅写文件；设 WINOJ_SANDBOX_VERBOSE=1 才同时输出到 stderr（D-L13）。
static std::string sandboxLogPath() {
    // 优先使用 WINOJ_ROOT 环境变量（与 cwd 无关）
    const char* root = getenv("WINOJ_ROOT");
    if (root && root[0])
        return std::string(root) + "\\log\\sandbox.log";
    // 否则按 exe 位置推导：exe 位于 <root>/backend/sandbox/，上推三级即项目根
    char exePath[MAX_PATH];
    if (!GetModuleFileNameA(NULL, exePath, MAX_PATH))
        return "";
    char* p1 = strrchr(exePath, '\\');
    if (p1) *p1 = '\0';   // 去掉 exe 文件名
    char* p2 = strrchr(exePath, '\\');
    if (p2) *p2 = '\0';   // 去掉 \sandbox
    char* p3 = strrchr(exePath, '\\');
    if (p3) *p3 = '\0';   // 去掉 \backend → 项目根
    return std::string(exePath) + "\\log\\sandbox.log";
}

static void sandboxLogRaw(const std::string& line) {
    // 同步追加写文件
    std::string path = sandboxLogPath();
    if (!path.empty()) {
        std::string dir = path.substr(0, path.find_last_of("\\/"));
        CreateDirectoryA(dir.c_str(), NULL); // 已存在则忽略
        FILE* f = fopen(path.c_str(), "a");
        if (f) {
            fwrite(line.data(), 1, line.size(), f);
            fclose(f);
        }
    }
    // 诊断日志仅追加写文件，不再默认混入 stderr（D-L13：避免污染用户
    // 程序的 stderr 且被统计进输出额度）。
    // 管理员排障时设 WINOJ_SANDBOX_VERBOSE=1 才同时输出到 stderr。
    static bool verbose = []() {
        const char* v = getenv("WINOJ_SANDBOX_VERBOSE");
        return v && v[0] == '1';
    }();
    if (verbose) {
        fputs(line.c_str(), stderr);
        fflush(stderr);
    }
}

static void sandboxLog(const char* fmt, ...) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    char head[64], body[2048];
    snprintf(head, sizeof(head), "[%04d-%02d-%02d %02d:%02d:%02d.%03d] [sandbox] ",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(body, sizeof(body), fmt, ap);
    va_end(ap);
    std::string line = std::string(head) + body + "\n";
    sandboxLogRaw(line);
}

static void sandboxLogW(const wchar_t* fmt, ...) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    char head[64];
    snprintf(head, sizeof(head), "[%04d-%02d-%02d %02d:%02d:%02d.%03d] [sandbox] ",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    wchar_t bodyW[4096];
    va_list ap;
    va_start(ap, fmt);
    vswprintf(bodyW, 4096, fmt, ap);
    va_end(ap);
    int n = WideCharToMultiByte(CP_UTF8, 0, bodyW, -1, NULL, 0, NULL, NULL);
    std::string body(n > 0 ? n - 1 : 0, '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, bodyW, -1, &body[0], n, NULL, NULL);
    sandboxLogRaw(std::string(head) + body + "\n");
}

// ── 构造子进程最小白名单环境块 ─────────────────────────────
// D-L12: 子进程不应继承父进程完整环境变量（可能含 API 密钥等敏感值）。
// 只保留运行解释器/编译产物所需的最小集合（PATH / SystemRoot / TEMP /
// TMP / COMPUTERNAME / USERNAME / OS），避免环境变量探测与密钥泄露。
// 返回 CreateProcess lpEnvironment 格式的内存块（VAR=value\0 ... \0\0）。
static std::vector<char> buildMinEnvBlock() {
    const char* names[] = {
        "PATH", "SystemRoot", "TEMP", "TMP", "COMPUTERNAME",
        "USERNAME", "USERPROFILE", "OS", "PATHEXT", "HOMEDRIVE",
        "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"
    };
    std::string block;
    for (const char* n : names) {
        const char* v = getenv(n);
        if (v && v[0]) {
            block += n;
            block += '=';
            block += v;
            block += '\0';
        }
    }
    block += '\0'; // 结束空串
    return std::vector<char>(block.begin(), block.end());
}

// ── Windows CRT 命令行参数转义（MSDN "Parsing C Command-Line Arguments"）──
// 规则：反斜杠序列在引号内是转义符——偶数个 \ 表示字面反斜杠，奇数个 \ 表示
// 转义后面的引号。因此进入/退出引号前必须按"需要多少字面反斜杠就翻倍"处理：
//   1) 对参数中每段连续反斜杠，若其后面紧跟 `"`，反斜杠数量翻倍；
//   2) 参数尾部的连续反斜杠翻倍（其后是收尾引号）。
// 否则路径如 C:\foo"bar 会被解析错乱，甚至被注入改变命令结构（D-L13）。
static std::string quoteCmdArg(const char* arg) {
    std::string out = "\"";
    size_t backslashes = 0;
    for (const char* p = arg; *p; p++) {
        if (*p == '\\') { backslashes++; continue; }
        if (*p == '"') {
            // 引号前的反斜杠全部翻倍（转义这些反斜杠，避免它们转义引号）
            out.append(backslashes * 2, '\\');
            out += "\\\""; // 转义引号本身
            backslashes = 0;
        } else {
            out.append(backslashes, '\\');
            out += *p;
            backslashes = 0;
        }
    }
    // 参数尾部反斜杠翻倍（其后是收尾引号）
    out.append(backslashes * 2, '\\');
    out += '"';
    return out;
}

// ── 打开当前进程令牌（完整权限）────────────────────────────
// 关键：必须带 TOKEN_ASSIGN_PRIMARY，否则派生出的受限令牌缺少该访问权，
// CreateProcessAsUser 会报 ERROR_ACCESS_DENIED。
static HANDLE openSelfTokenFull() {
    HANDLE hTok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
                          &hTok))
        return NULL;
    return hTok;
}

// ── 从指定基令牌创建受限令牌: 禁用特权组 + 剥离高危特权 ────
static HANDLE createRestrictedTokenFrom(HANDLE hCurrentToken) {
    if (!hCurrentToken) return NULL;

    std::vector<LUID> denyLuids;
    const char* privNames[] = {
        SE_DEBUG_NAME, SE_IMPERSONATE_NAME, SE_ASSIGNPRIMARYTOKEN_NAME,
        SE_TCB_NAME, SE_LOAD_DRIVER_NAME, SE_BACKUP_NAME,
        SE_RESTORE_NAME, SE_SECURITY_NAME, SE_TAKE_OWNERSHIP_NAME,
        SE_MANAGE_VOLUME_NAME, SE_CREATE_PAGEFILE_NAME,
        SE_SHUTDOWN_NAME, SE_SYSTEM_ENVIRONMENT_NAME, SE_UNDOCK_NAME,
        SE_PROF_SINGLE_PROCESS_NAME, SE_INCREASE_QUOTA_NAME,
        SE_INC_BASE_PRIORITY_NAME, SE_CREATE_SYMBOLIC_LINK_NAME,
    };
    for (const char* name : privNames) {
        LUID luid;
        if (LookupPrivilegeValueA(NULL, name, &luid))
            denyLuids.push_back(luid);
    }

    std::vector<LUID_AND_ATTRIBUTES> privsToDelete;
    for (const auto& luid : denyLuids)
        privsToDelete.push_back({ luid, 0 });

    // 禁用特权组：Administrators / Backup Operators / Replicate / Print Operators
    SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY;
    PSID groupSids[4] = { NULL, NULL, NULL, NULL };
    DWORD groupAuth[4][2] = {
        { SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS },
        { SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_BACKUP_OPS },
        { SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_REPLICATOR },
        { SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_PRINT_OPS },
    };
    std::vector<SID_AND_ATTRIBUTES> groupsToDisable;
    for (int i = 0; i < 4; i++) {
        if (AllocateAndInitializeSid(&nt, 2, groupAuth[i][0], groupAuth[i][1],
                                     0, 0, 0, 0, 0, 0, &groupSids[i]))
            groupsToDisable.push_back({ groupSids[i], 0 });
    }

    HANDLE hRestricted = NULL;
    BOOL ok = CreateRestrictedToken(
        hCurrentToken, 0,
        (DWORD)groupsToDisable.size(), groupsToDisable.empty() ? NULL : groupsToDisable.data(),
        (DWORD)privsToDelete.size(), privsToDelete.data(),
        0, NULL,
        &hRestricted
    );
    for (int i = 0; i < 4; i++)
        if (groupSids[i]) LocalFree(groupSids[i]);
    return ok ? hRestricted : NULL;
}

static HANDLE createRestrictedToken() {
    HANDLE hTok = openSelfTokenFull();
    HANDLE hRes = createRestrictedTokenFrom(hTok);
    if (hTok) CloseHandle(hTok);
    return hRes;
}

// ── 启用当前进程特权（CreateProcessAsUser 所需）────────────
// CreateProcessAsUser 要求调用进程持有 SeAssignPrimaryTokenPrivilege
// 和 SeIncreaseQuotaPrivilege 特权。普通用户令牌中这两个特权通常不存在
//（甚至无法启用），只有提权/服务环境下才可能可用。
static void enablePrivilege(const char* name) {
    HANDLE hTok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hTok))
        return;
    LUID luid;
    if (!LookupPrivilegeValueA(NULL, name, &luid)) { CloseHandle(hTok); return; }
    TOKEN_PRIVILEGES tp = {};
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Luid = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    AdjustTokenPrivileges(hTok, FALSE, &tp, 0, NULL, NULL);
    CloseHandle(hTok);
}

// ── 查询特权是否已启用 ─────────────────────────────────────
// 注意: GetTokenInformation 需要先查询长度再分配，否则特权较多时
// 会返回 ERROR_INSUFFICIENT_BUFFER（之前的实现因此恒为 false）。
static bool hasPrivilege(const char* name) {
    HANDLE hTok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &hTok))
        return false;
    LUID luid;
    if (!LookupPrivilegeValueA(NULL, name, &luid)) {
        CloseHandle(hTok);
        return false;
    }
    DWORD len = 0;
    GetTokenInformation(hTok, TokenPrivileges, NULL, 0, &len);
    if (!len) { CloseHandle(hTok); return false; }
    std::vector<char> buf(len);
    BOOL ok = GetTokenInformation(hTok, TokenPrivileges, buf.data(), len, &len);
    CloseHandle(hTok);
    if (!ok) return false;
    TOKEN_PRIVILEGES* tp = (TOKEN_PRIVILEGES*)buf.data();
    for (DWORD i = 0; i < tp->PrivilegeCount; i++)
        if (tp->Privileges[i].Luid.HighPart == luid.HighPart && tp->Privileges[i].Luid.LowPart == luid.LowPart &&
            (tp->Privileges[i].Attributes & SE_PRIVILEGE_ENABLED))
            return true;
    return false;
}

// ── AppContainer 令牌构建 ──────────────────────────────────
// CreateAppContainerToken 在 Win10/11 上由 kernelbase.dll 导出，
// 老系统在 userenv.dll（且 Winlibs 导入库未导出该符号），因此运行时动态解析。
typedef HRESULT (WINAPI *FnCreateAppContainerToken)(HANDLE, PSID_AND_ATTRIBUTES, DWORD, PHANDLE);

static bool buildAppContainerToken(HANDLE baseToken, PSID* outSid, HANDLE* outToken) {
    // 每次评测用独立包名 → 独立包 SID → 题与题之间互不可见
    char name[80];
    snprintf(name, sizeof(name), "WinOJ.Sandbox.%lu.%lu",
             (unsigned long)GetCurrentProcessId(), (unsigned long)GetTickCount());
    wchar_t wname[160];
    MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 160);

    PSID appSid = NULL;
    if (FAILED(DeriveAppContainerSidFromAppContainerName(wname, &appSid)))
        return false;

    const char* dlls[] = { "kernelbase.dll", "userenv.dll" };
    FnCreateAppContainerToken fn = NULL;
    for (const char* dll : dlls) {
        HMODULE h = GetModuleHandleA(dll);
        if (!h) continue;
        fn = (FnCreateAppContainerToken)GetProcAddress(h, "CreateAppContainerToken");
        if (fn) break;
    }
    if (!fn) { LocalFree(appSid); return false; }

    HANDLE hContainer = NULL;
    if (FAILED(fn(baseToken, NULL, 0, &hContainer))) { LocalFree(appSid); return false; }

    *outSid = appSid;
    *outToken = hContainer;
    return true;
}

// ── 容器令牌创建：子进程隔离模式 ───────────────────────────
// 某些系统上 CreateAppContainerToken 会直接访问违例崩溃。把它放到独立
// 子进程里执行，崩溃也只影响该子进程，父进程可安全回退到受限令牌。
// 子进程把结果（包 SID + 令牌句柄数值）写到专用管道；随后阻塞等待 stdin
// 关闭作为"父进程已取走句柄"的信号，再退出。
static bool containerHelperWaitRelease() {
    char buf[64];
    DWORD n = 0;
    ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof(buf), &n, NULL);
    return true;
}

// 独立子进程入口（由主进程自动以 --make-container 调用）
static int containerHelperMain() {
    HANDLE hSelf = openSelfTokenFull();
    if (!hSelf) {
        sandboxLog("container-helper: openSelfTokenFull failed (error %lu)", GetLastError());
        printf("FAIL 1\n"); fflush(stdout); containerHelperWaitRelease(); return 1;
    }
    HANDLE hRestricted = createRestrictedTokenFrom(hSelf);
    if (!hRestricted) {
        sandboxLog("container-helper: createRestrictedTokenFrom failed (error %lu)", GetLastError());
        printf("FAIL 2\n"); fflush(stdout); containerHelperWaitRelease(); return 2;
    }

    PSID sid = NULL;
    HANDLE hContainer = NULL;
    if (!buildAppContainerToken(hRestricted, &sid, &hContainer)) {
        sandboxLog("container-helper: buildAppContainerToken failed");
        printf("FAIL 3\n"); fflush(stdout);
        CloseHandle(hRestricted); CloseHandle(hSelf);
        containerHelperWaitRelease();
        return 3;
    }

    sandboxLog("container-helper: token built OK");

    char sidStr[256] = "";
    LPSTR sidOut = NULL;
    if (ConvertSidToStringSidA(sid, &sidOut) && sidOut) {
        strncpy(sidStr, sidOut, sizeof(sidStr) - 1);
        LocalFree(sidOut);
    }
    printf("SID %s\nTOKEN 0x%llX\nREADY\n",
           sidStr, (unsigned long long)(uintptr_t)hContainer);
    fflush(stdout);
    // 保持令牌句柄存活，直到父进程完成 DuplicateHandle
    containerHelperWaitRelease();
    CloseHandle(hContainer);
    LocalFree(sid);
    CloseHandle(hRestricted);
    CloseHandle(hSelf);
    return 0;
}

// 主进程侧: 拉起子进程构建容器令牌，并通过 DuplicateHandle 把句柄带回
static bool spawnContainerHelper(PSID* outSid, HANDLE* outToken) {
    SECURITY_ATTRIBUTES saPipe = { sizeof(saPipe), NULL, TRUE };
    HANDLE hInR = NULL, hInW = NULL, hOutR = NULL, hOutW = NULL;
    if (!CreatePipe(&hInR, &hInW, &saPipe, 0)) return false;
    if (!CreatePipe(&hOutR, &hOutW, &saPipe, 0)) {
        CloseHandle(hInR); CloseHandle(hInW);
        return false;
    }

    char selfPath[MAX_PATH];
    if (!GetModuleFileNameA(NULL, selfPath, MAX_PATH)) {
        CloseHandle(hInR); CloseHandle(hInW);
        CloseHandle(hOutR); CloseHandle(hOutW);
        return false;
    }

    STARTUPINFOA si = {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = hInR;
    si.hStdOutput = hOutW;
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE); // 让辅助进程告警进判题日志
    PROCESS_INFORMATION hp = {};

    std::string cmdLine = std::string("\"") + selfPath + "\" --make-container";
    std::vector<char> cbuf(cmdLine.begin(), cmdLine.end());
    cbuf.push_back('\0');
    if (!CreateProcessA(NULL, cbuf.data(), NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &hp)) {
        CloseHandle(hInR); CloseHandle(hInW);
        CloseHandle(hOutR); CloseHandle(hOutW);
        return false;
    }
    CloseHandle(hInR);
    CloseHandle(hOutW);

    // 读取子进程结果（有限等待，防止子进程挂死导致死锁）
    std::string output;
    DWORD deadline = GetTickCount() + 5000;
    bool sawReady = false;
    while (GetTickCount() < deadline) {
        DWORD avail = 0;
        if (!PeekNamedPipe(hOutR, NULL, 0, NULL, &avail, NULL)) break;
        if (avail > 0) {
            char buf[1024];
            DWORD n = 0;
            if (!ReadFile(hOutR, buf, sizeof(buf) - 1, &n, NULL) || n == 0) break;
            buf[n] = '\0';
            output += buf;
            if (output.find("READY") != std::string::npos ||
                output.find("FAIL") != std::string::npos) {
                sawReady = true;
                break;
            }
        } else {
            if (WaitForSingleObject(hp.hProcess, 0) == WAIT_OBJECT_0) break; // 子进程已崩溃/退出
            Sleep(10);
        }
    }

    // 解析 "SID <sid> / TOKEN 0x.. / READY"
    bool ok = false;
    if (sawReady && output.find("READY") != std::string::npos) {
        char sidStr[300] = "";
        unsigned long long hval = 0;
        bool gotSid = false, gotTok = false;
        size_t pos = 0;
        while (pos < output.size()) {
            size_t eol = output.find('\n', pos);
            if (eol == std::string::npos) eol = output.size();
            std::string line = output.substr(pos, eol - pos);
            pos = eol + 1;
            if (line.size() > 4 && line.compare(0, 4, "SID ") == 0) {
                sscanf(line.c_str() + 4, "%299[^\r\n]", sidStr);
                gotSid = strlen(sidStr) > 0;
            } else if (line.size() > 6 && line.compare(0, 6, "TOKEN ") == 0) {
                gotTok = sscanf(line.c_str() + 6, "0x%llX", &hval) == 1;
            }
        }
        if (gotSid && gotTok) {
            PSID sid = NULL;
            if (ConvertStringSidToSidA(sidStr, &sid)) {
                HANDLE dup = NULL;
                if (DuplicateHandle(hp.hProcess, (HANDLE)(uintptr_t)hval,
                                    GetCurrentProcess(), &dup, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
                    *outSid = sid;
                    *outToken = dup;
                    ok = true;
                } else {
                    LocalFree(sid);
                }
            }
        }
    }

    // 通知子进程可退出（关闭其 stdin 写端），并等待它结束
    CloseHandle(hInW);
    hInW = NULL;
    WaitForSingleObject(hp.hProcess, 5000);
    CloseHandle(hp.hThread);
    CloseHandle(hp.hProcess);
    CloseHandle(hOutR);
    if (!ok) {
        // 记录子进程原始输出，便于定位是崩溃还是 API 返回失败
        std::string logOut;
        for (size_t i = 0; i < output.size(); i++) {
            char c = output[i];
            if (c == '\r') continue;
            if (c == '\n') logOut += " | ";
            else logOut += (c >= 32 && c < 127) ? c : '?';
        }
        sandboxLog("AppContainer token creation failed (service unavailable or crashed) - using restricted token (helper output: %s)", logOut.c_str());
    }
    return ok;
}

// ── 路径辅助 ───────────────────────────────────────────────
static std::wstring utf8ToWide(const char* s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    std::wstring ws(n > 0 ? (size_t)n - 1 : 0, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, -1, &ws[0], n);
    return ws;
}

static std::wstring dirNameW(const std::wstring& p) {
    size_t pos = p.find_last_of(L"\\/");
    if (pos == std::wstring::npos) return L"";
    if (pos == 0) return p.substr(0, 1);
    return p.substr(0, pos);
}

static std::wstring baseNameW(const std::wstring& p) {
    size_t pos = p.find_last_of(L"\\/");
    return pos == std::wstring::npos ? p : p.substr(pos + 1);
}

// 收集 path 到磁盘根的全部祖先目录（含叶子本身与磁盘根）
static void collectAncestors(const std::wstring& path, std::vector<std::wstring>& out) {
    std::wstring cur = path;
    while (!cur.empty() && (cur.back() == L'\\' || cur.back() == L'/'))
        cur.pop_back();
    while (cur.size() >= 2) {
        if (cur.size() == 2 && cur[1] == L':') {
            out.push_back(cur + L"\\");
            break;
        }
        out.push_back(cur);
        size_t pos = cur.find_last_of(L"\\/");
        if (pos == std::wstring::npos) break;
        if (pos == 0) cur = cur.substr(0, 1);
        else cur = cur.substr(0, pos);
    }
}

// ── ACL 辅助 ───────────────────────────────────────────────
// 给指定路径的 DACL 追加一条"授予 sid 指定权限"的 ACE
static bool addAceToDaclW(const wchar_t* path, PSID sid, DWORD access, DWORD inheritance) {
    PACL pOld = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                              NULL, NULL, &pOld, NULL, &sd) != ERROR_SUCCESS)
        return false;
    EXPLICIT_ACCESSA ea = {};
    ea.grfAccessMode = GRANT_ACCESS;
    ea.grfAccessPermissions = access;
    ea.grfInheritance = inheritance;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.ptstrName = (LPSTR)sid;
    PACL pNew = NULL;
    DWORD rc = SetEntriesInAclA(1, &ea, pOld, &pNew);
    if (sd) LocalFree(sd);
    if (rc != ERROR_SUCCESS) return false;
    DWORD r2 = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                     DACL_SECURITY_INFORMATION, NULL, NULL, pNew, NULL);
    if (pNew) LocalFree(pNew);
    return r2 == ERROR_SUCCESS;
}

// 从单个路径的 DACL 中移除属于 sid 的所有 ACE
static void removeSidAceFromPathW(const wchar_t* path, PSID sid) {
    PACL pOld = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                              NULL, NULL, &pOld, NULL, &sd) != ERROR_SUCCESS)
        return;
    std::vector<EXPLICIT_ACCESSA> keep;
    if (pOld) {
        DWORD count = 0;
        PEXPLICIT_ACCESSA entries = NULL;
        if (GetExplicitEntriesFromAclA(pOld, &count, &entries) == ERROR_SUCCESS) {
            for (DWORD i = 0; i < count; i++) {
                if (entries[i].Trustee.TrusteeForm == TRUSTEE_IS_SID &&
                    entries[i].Trustee.ptstrName &&
                    EqualSid(entries[i].Trustee.ptstrName, sid))
                    continue;
                keep.push_back(entries[i]);
            }
            // 注意: entries 必须在 SetEntriesInAclA 之后再释放（keep 里的 SID 指针指向它）
            PACL pNew = NULL;
            if (SetEntriesInAclA((DWORD)keep.size(), keep.empty() ? NULL : keep.data(),
                                 NULL, &pNew) == ERROR_SUCCESS) {
                SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                      NULL, NULL, pNew, NULL);
                if (pNew) LocalFree(pNew);
            }
            if (entries) LocalFree(entries);
        }
    }
    if (sd) LocalFree(sd);
}

// 给 path 的祖先链授予 FILE_TRAVERSE | FILE_READ_ATTRIBUTES，并记录改动路径
static void grantTraverseAncestors(const std::wstring& path, PSID sid,
                                   std::vector<std::wstring>& touched) {
    std::vector<std::wstring> anc;
    collectAncestors(path, anc);
    for (auto& a : anc) {
        if (addAceToDaclW(a.c_str(), sid, FILE_TRAVERSE | FILE_READ_ATTRIBUTES, 0))
            touched.push_back(a);
    }
}

// 递归给 root 下所有文件/目录授予 access（目录带继承标志），并记录改动路径
static void grantTreeRecursive(const wchar_t* root, PSID sid, DWORD access,
                               std::vector<std::wstring>& touched) {
    if (addAceToDaclW(root, sid, access, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE))
        touched.push_back(std::wstring(root));
    std::wstring pat = std::wstring(root) + L"\\*";
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pat.c_str(), &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        std::wstring sub = std::wstring(root) + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            grantTreeRecursive(sub.c_str(), sid, access, touched);
        else if (addAceToDaclW(sub.c_str(), sid, access, 0))
            touched.push_back(sub);
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
}

// 给解释器授权（运行文件在 workDir 之外时）：祖先 traverse + 目录树 读+执行
// java 特例: exe 位于 <jdk>/bin 下，还需授权 <jdk> 整棵目录树
static void grantInterpreterTree(const std::wstring& exePath, PSID sid,
                                 std::vector<std::wstring>& touched) {
    std::wstring exeDir = dirNameW(exePath);
    std::wstring exeName = baseNameW(exePath);
    grantTraverseAncestors(exePath, sid, touched);
    grantTreeRecursive(exeDir.c_str(), sid, FILE_GENERIC_READ | FILE_EXECUTE, touched);
    if (_wcsicmp(exeName.c_str(), L"java.exe") == 0 ||
        _wcsicmp(exeName.c_str(), L"javaw.exe") == 0) {
        std::wstring jhome = dirNameW(exeDir);
        if (!jhome.empty()) {
            grantTraverseAncestors(jhome, sid, touched);
            grantTreeRecursive(jhome.c_str(), sid, FILE_GENERIC_READ | FILE_EXECUTE, touched);
        }
    }
}

// 撤销之前记录的所有 ACE 改动（运行结束后调用，防止死 ACL 堆积）
static void cleanupAclGrants(const std::vector<std::wstring>& touched, PSID sid) {
    for (auto it = touched.rbegin(); it != touched.rend(); ++it)
        removeSidAceFromPathW(it->c_str(), sid);
}

// 把单个路径的强制完整性标签设为 LOW（仅更新 LABEL，不动 DACL）。
// 关键点：LABEL_SECURITY_INFORMATION 对应的是 SACL 中的"标签 ACE"
//（SYSTEM_MANDATORY_LABEL_ACE），因此必须通过 pNewSacl 参数（第7参）传入，
// 而非 pNewDacl（第6参，用于普通 DACL ACE）。标签 ACE 的 Mask 放强制策略位
//（NO_WRITE_UP = 禁止向上写）。
// 文件标为 Low IL 后，Low/Medium/High 进程皆可写（完整性策略只禁止"向上写"）。
static bool setLowLabelOnPath(const wchar_t* path, DWORD inh) {
    PSID lowSid = NULL;
    SID_IDENTIFIER_AUTHORITY ia = SECURITY_MANDATORY_LABEL_AUTHORITY;
    if (!AllocateAndInitializeSid(&ia, 1, SECURITY_MANDATORY_LOW_RID, 0, 0, 0, 0, 0, 0, 0, &lowSid)) return false;
    DWORD sidLen = GetLengthSid(lowSid);
    DWORD aceSize = sizeof(SYSTEM_MANDATORY_LABEL_ACE) + sidLen - sizeof(DWORD);
    DWORD aclSize = sizeof(ACL) + aceSize;

    PACL pAcl = (PACL)LocalAlloc(LPTR, aclSize);
    bool ok = false;
    if (pAcl && InitializeAcl(pAcl, aclSize, ACL_REVISION)) {
        SYSTEM_MANDATORY_LABEL_ACE* mace = (SYSTEM_MANDATORY_LABEL_ACE*)LocalAlloc(LPTR, aceSize);
        if (mace) {
            mace->Header.AceType = SYSTEM_MANDATORY_LABEL_ACE_TYPE;
            mace->Header.AceFlags = (BYTE)inh;
            mace->Header.AceSize = (WORD)aceSize;
            mace->Mask = SYSTEM_MANDATORY_LABEL_NO_WRITE_UP;
            CopySid(sidLen, &mace->SidStart, lowSid);
            if (AddAce(pAcl, ACL_REVISION, MAXDWORD, mace, aceSize))
                ok = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                           LABEL_SECURITY_INFORMATION, NULL, NULL, NULL, pAcl) == ERROR_SUCCESS;
            LocalFree(mace);
        }
    }
    if (pAcl) LocalFree(pAcl);
    LocalFree(lowSid);
    return ok;
}

// 递归把 root 下所有文件/目录的强制完整性标签设为 LOW（目录带继承标志）。
// 用于受限令牌 + Low-IL 路径：子进程以 Low IL 运行，若 workDir 仍是 Medium
// 标签，完整性强制策略（no-write-up）会拒绝其写入，导致提交写 cwd 文件变 RE。
static void setLowLabelRecursive(const wchar_t* root) {
    setLowLabelOnPath(root, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE);
    std::wstring pat = std::wstring(root) + L"\\*";
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pat.c_str(), &fd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            std::wstring sub = std::wstring(root) + L"\\" + fd.cFileName;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                setLowLabelRecursive(sub.c_str());
            else
                setLowLabelOnPath(sub.c_str(), 0);
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
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
// 递归删除目录树（用于清理被恶意创建的目录型 _meta.json）
static void deleteTreeW(const wchar_t* root) {
    std::wstring pat = std::wstring(root) + L"\\*";
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pat.c_str(), &fd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            std::wstring sub = std::wstring(root) + L"\\" + fd.cFileName;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                deleteTreeW(sub.c_str());
            else
                DeleteFileW(sub.c_str());
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
    RemoveDirectoryW(root);
}

// D-L14: 写入元数据前确保 metaFile 不是目录。
// 恶意提交可在 workDir 内预创建名为 _meta.json 的目录，导致 fopen("w") 失败、
// 元数据丢失（executor 读不到 meta → 回退到进程退出码，判题信息失真）。
static void ensureMetaPath(const char* path) {
    std::wstring wp = utf8ToWide(path);
    DWORD attr = GetFileAttributesW(wp.c_str());
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY))
        deleteTreeW(wp.c_str());
}

static void writeMeta(const char* path, int exitCode, DWORD timeMs, SIZE_T memKB, const char* signal) {
    ensureMetaPath(path);
    FILE* f = fopen(path, "w");
    if (!f) return;
    // JSON 字符串转义：防止 signal 含双引号/反斜杠导致元数据被破坏
    std::string sig(signal ? signal : "");
    std::string esc;
    for (char c : sig) {
        if (c == '"' || c == '\\') esc += '\\';
        esc += c;
    }
    fprintf(f, "{\"exit_code\":%d,\"time_used\":%lu,\"memory_used\":%llu,\"signal\":\"%s\"}",
            exitCode, (unsigned long)timeMs, (unsigned long long)memKB, esc.c_str());
    fclose(f);
}

// ── 主函数 ─────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    // 容器令牌构建子进程模式（主进程自动拉起）
    if (argc == 2 && strcmp(argv[1], "--make-container") == 0)
        return containerHelperMain();

    // 解析 --file-io 参数（文件IO题目模式：强制 workDir 降为 Low IL）
    bool fileIoMode = false;
    int argOffset = 1;
    if (argc >= 2 && strcmp(argv[1], "--file-io") == 0) {
        fileIoMode = true;
        argOffset = 2;
    }

    if (argc - argOffset < 5) {
        fprintf(stderr, "Usage: sandbox_runner.exe [--file-io] <time_ms> <mem_mb> <max_proc> <meta_file> <exe> [args...]\n");
        return 1;
    }

    DWORD timeLimitMs   = (DWORD)atoll(argv[argOffset]);
    SIZE_T memLimitBytes = (SIZE_T)atoll(argv[argOffset + 1]) * 1024 * 1024;
    DWORD maxProcs      = (DWORD)atoll(argv[argOffset + 2]);
    const char* metaFile = argv[argOffset + 3];
    const char* exePath  = argv[argOffset + 4];

    // 构建命令行（D-L13：标准 CRT 转义，正确处理反斜杠+引号组合）
    std::string cmdLine;
    for (int i = argOffset + 4; i < argc; i++) {
        if (i > argOffset + 4) cmdLine += " ";
        cmdLine += quoteCmdArg(argv[i]);
    }
    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');

    // 1. 创建 Job Object
    HANDLE hJob = createJob(timeLimitMs, memLimitBytes, maxProcs);
    if (!hJob) {
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        sandboxLog("Failed to create Job Object");
        return 1;
    }

    // 2. 尝试启用特权（提权/服务环境），据此选择隔离方案
    enablePrivilege(SE_ASSIGNPRIMARYTOKEN_NAME);
    enablePrivilege(SE_INCREASE_QUOTA_NAME);
    bool haveAssignPrimary = hasPrivilege(SE_ASSIGNPRIMARYTOKEN_NAME);

    // 2b. 构建受限令牌（禁用特权组 + 剥离高危特权）
    HANDLE hRestricted = createRestrictedToken();

    PSID appSid = NULL;
    HANDLE hContainer = NULL;
    bool useAppContainer = false;

    // 环境变量逃生阀：WINOJ_NO_APPCONTAINER=1 时完全跳过容器路径
    bool containerEnabled = true;
    {
        const char* env = getenv("WINOJ_NO_APPCONTAINER");
        if (env && env[0] == '1') containerEnabled = false;
    }
    // 诊断开关：WINOJ_FORCE_CONTAINER=1 时即使无特权也尝试容器路径
    //（容器令牌在子进程构建，崩溃仍安全回退，仅用于管理员排查）
    bool forceContainer = false;
    {
        const char* env = getenv("WINOJ_FORCE_CONTAINER");
        if (env && env[0] == '1') forceContainer = true;
    }
    // 管理员诊断开关：WINOJ_EXEC_MODE 切换子进程创建路径
    //   0 = 默认（受限令牌 + Low Integrity，先尝试容器，基线）
    //   1 = 受限令牌 + 强制 Low Integrity（等价默认，保留兼容）
    //   2 = 裸进程 CreateProcessA（继承提权令牌）
    //   3 = 受限令牌 + 不带 CREATE_NO_WINDOW
    int execMode = 0;
    {
        const char* em = getenv("WINOJ_EXEC_MODE");
        if (em && em[0]) execMode = atoi(em);
    }

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

    // 提权环境下 CREATE_NO_WINDOW 会导致子进程 DLL 初始化失败
    // (0xC0000142) 而完全没有输出（详见管理员诊断：mode0 冻结/mode3 正常）。
    // stdio 句柄已重定向到管道/文件时该标志本就多余，直接去除。
    DWORD flags = CREATE_SUSPENDED;

    // D-L12: 子进程使用最小白名单环境（不再继承父进程完整环境变量，
    // 防止 API 密钥等敏感环境变量被评测程序读取）。
    std::vector<char> envBlock = buildMinEnvBlock();
    LPCH lpEnv = envBlock.data();

    // C-1: 受限令牌路径默认降为 Low Integrity（普通用户部署也能获得
    // 文件系统/进程低完整性隔离，禁止写入高完整性位置、削弱对其他
    // 同用户进程的攻击面）。AppContainer 自身强制 Low/Untrusted IL，
    // 无需额外处理。逃生阀 WINOJ_NO_LOWIL=1 显式关闭；
    // 诊断模式 2（裸进程）与 AppContainer 优先路径不受影响。
    bool lowIl = true;
    {
        const char* env = getenv("WINOJ_NO_LOWIL");
        if (env && env[0] == '1') lowIl = false;
    }
    if (lowIl && execMode != 2 && hRestricted) {
        TOKEN_MANDATORY_LABEL low = {};
        SID_IDENTIFIER_AUTHORITY ia = SECURITY_MANDATORY_LABEL_AUTHORITY;
        if (AllocateAndInitializeSid(&ia, 1, SECURITY_MANDATORY_LOW_RID, 0, 0, 0, 0, 0, 0, 0, &low.Label.Sid)) {
            low.Label.Attributes = SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED;
            SetTokenInformation(hRestricted, TokenIntegrityLevel, &low, sizeof(low));
            LocalFree(low.Label.Sid);
        }
    }

    BOOL ok = FALSE;
    const char* createFn = NULL;

    if (execMode == 2) {
        // 模式2：裸进程，跳过令牌路径
        createFn = "CreateProcessA(bare)";
        ok = CreateProcessA(NULL, cmdBuf.data(), &sa, &sa, TRUE, flags, lpEnv, NULL, &si, &pi);
        if (!ok)
            sandboxLog("CreateProcessA(bare) failed (error %lu)", GetLastError());
    } else {
        // 仅当持有 SeAssignPrimaryTokenPrivilege（管理员/服务环境）才尝试 AppContainer，
        // 且容器令牌在独立子进程中构建：某些系统上 CreateAppContainerToken 会崩溃，
        // 隔离后崩溃只影响子进程，不影响判题流程与输出捕获。
        if (containerEnabled && (haveAssignPrimary || forceContainer) && hRestricted) {
            useAppContainer = spawnContainerHelper(&appSid, &hContainer);
            if (useAppContainer) {
                createFn = "CreateProcessAsUserA(AppContainer)";
                ok = CreateProcessAsUserA(hContainer, NULL, cmdBuf.data(), &sa, &sa, TRUE, flags, lpEnv, NULL, &si, &pi);
                if (!ok) {
                    sandboxLog("CreateProcessAsUser(AppContainer) failed (error %lu), falling back to restricted token", GetLastError());
                    useAppContainer = false;
                }
            }
        }

        // 受限令牌路径：同用户令牌 + TOKEN_ASSIGN_PRIMARY 时普通用户也能启动成功
        if (!ok && hRestricted) {
            createFn = "CreateProcessAsUserA(restricted)";
            ok = CreateProcessAsUserA(hRestricted, NULL, cmdBuf.data(), &sa, &sa, TRUE, flags, lpEnv, NULL, &si, &pi);
            if (!ok)
                sandboxLog("CreateProcessAsUser(restricted) failed (error %lu)", GetLastError());
        }

        // C-2: 令牌路径全部失败时必须 fail-closed（写 SYSTEM_ERROR 拒绝执行），
        // 绝不回退裸 CreateProcessA（管理员/服务启动时回退 = 恶意代码提权执行）。
        // 仅保留 WINOJ_EXEC_MODE=2 显式诊断开关（管理员手动设置）才走裸进程路径。
        if (!ok) {
            DWORD err = GetLastError();
            sandboxLog("All sandbox token paths failed (error %lu); refusing to run without isolation", err);
            writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
            CloseHandle(hJob);
            if (hContainer) CloseHandle(hContainer);
            if (appSid) LocalFree(appSid);
            if (hRestricted) CloseHandle(hRestricted);
            return 1;
        }
    }

    if (!ok) {
        DWORD err = GetLastError();
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        sandboxLog("%s failed (error %lu)", createFn, err);
        CloseHandle(hJob);
        if (hContainer) CloseHandle(hContainer);
        if (appSid) LocalFree(appSid);
        if (hRestricted) CloseHandle(hRestricted);
        return 1;
    }

    // 3b. Low-IL 路径把 workDir 完整性标签递归降为 LOW：
    // 子进程以 Low IL 运行时，若 workDir 仍是 Medium 标签，完整性强制策略
    // （no-write-up）会拒绝其写 cwd（freopen 输出/临时文件），提交变 RE。
    // AppContainer 路径由容器 SID 的 DACL 授权（AppContainer 令牌 IL 已为 Low，
    // 且容器有专属写权限），无需降标签；裸进程诊断（mode2）不受影响。
    // 该 workDir 为每次判题独有临时目录，运行后即被 executor 清理，无需恢复标签。
    // 逃生阀 WINOJ_NO_RELABEL=1 跳过内部降标签（用于验证外部已打标或排查）。
    bool noRelabel = false;
    {
        const char* env = getenv("WINOJ_NO_RELABEL");
        if (env && env[0] == '1') noRelabel = true;
    }
    bool workDirRelabeled = false;
    // 文件IO模式或常规Low IL路径：强制 workDir 降为 LOW
    // 文件IO模式下即使使用 AppContainer 也强制降标签，确保进程能写入工作目录
    if ((lowIl && execMode != 2 && !useAppContainer && !noRelabel) || fileIoMode) {
        if (!noRelabel) {
            std::wstring workDirW = dirNameW(utf8ToWide(metaFile));
            setLowLabelRecursive(workDirW.c_str());
            workDirRelabeled = true;
            sandboxLogW(L"workdir relabeled to LOW integrity: %ls", workDirW.c_str());
        }
    }

    // 4. 绑定到 Job Object (进程仍挂起)
    if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1);
        writeMeta(metaFile, -1, 0, 0, "SYSTEM_ERROR");
        sandboxLog("AssignProcessToJobObject failed");
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(hJob);
        if (hContainer) CloseHandle(hContainer);
        if (appSid) LocalFree(appSid);
        if (hRestricted) CloseHandle(hRestricted);
        return 1;
    }

    // 记录实际启用的隔离模式，便于管理员排查
    sandboxLog("mode=%s pid=%lu diagMode=%d", createFn, (unsigned long)pi.dwProcessId, execMode);

    // 4b. AppContainer 授权：workDir（含祖先 traverse）+ 解释器（读+执行）
    std::vector<std::wstring> aclTouched;
    if (useAppContainer && appSid) {
        std::wstring workDirW = dirNameW(utf8ToWide(metaFile));
        grantTraverseAncestors(workDirW, appSid, aclTouched);
        grantTreeRecursive(workDirW.c_str(), appSid, FILE_ALL_ACCESS, aclTouched);

        // 解析子进程真实镜像路径，判断是否为 workDir 之外的解释器
        WCHAR imgPath[MAX_PATH * 4];
        DWORD imgLen = MAX_PATH * 4;
        if (QueryFullProcessImageNameW(pi.hProcess, 0, imgPath, &imgLen)) {
            std::wstring img = imgPath;
            std::wstring wd = workDirW;
            for (size_t i = 0; i < img.size(); i++) img[i] = (wchar_t)towlower(img[i]);
            for (size_t i = 0; i < wd.size(); i++)  wd[i]  = (wchar_t)towlower(wd[i]);
            if (img.rfind(wd, 0) != 0) {
                grantInterpreterTree(imgPath, appSid, aclTouched);
            }
        }
        sandboxLogW(L"AppContainer ACTIVE: workDir=%ls, acl_touched=%lu",
            workDirW.c_str(), (unsigned long)aclTouched.size());
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

    // 8. 清理 — 撤销 ACL 授权，关闭 Job 触发 KILL_ON_JOB_CLOSE，杀掉所有残留子进程
    if (useAppContainer && appSid)
        cleanupAclGrants(aclTouched, appSid);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hJob);
    if (hContainer) CloseHandle(hContainer);
    if (appSid) LocalFree(appSid);
    if (hRestricted) CloseHandle(hRestricted);

    return 0;
}
