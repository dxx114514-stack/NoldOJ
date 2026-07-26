# WinOJ API 接口文档

所有接口前缀为 `/api/v1`。响应格式统一为 JSON。

## 通用说明

### 认证方式

大部分接口需要在请求头中携带 JWT Token：

```
Authorization: Bearer <access_token>
```

Access Token 有效期 15 分钟，过期后通过 `POST /auth/refresh` 刷新（需携带 HttpOnly Cookie 中的 refresh_token）。

封禁用户和被强制登出用户的 Access Token 和 Refresh Token 均会被拒绝（通过 `force_logout_at` 时间戳 + JWT `iat` 比对）。

### 角色层级

```
user（用户） < teacher（教师） < admin（管理员） < su（超级管理员）
```

### 错误响应格式

```json
{
  "code": 错误码,
  "reason": "ERR_错误类型",
  "message": "错误描述"
}
```

错误码：`1`=参数错误，`2`=状态错误，`3`=未找到，`4`=限流，`5`=未认证，`6`=权限不足。

### 安全审查

提交代码时自动调用本地 Ollama（默认 `localhost:11434`，模型 `qwen3:1.7b`）进行安全审查。发现恶意代码将自动封禁用户。代码少于 50 字符跳过审查。源代码上限 128KB (131072 字符)。

**提示词注入防护**：15 种注入模式检测、代码截断脱敏、AI 响应操纵检测。

可通过环境变量配置：
- `OLLAMA_URL` — Ollama API 地址
- `OLLAMA_MODEL` — 审查模型名称

---

## 1. 认证模块 `/auth`

### POST /auth/login — 登录

无需认证。封禁用户无法登录。

**请求体：**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**成功响应 (200)：**
```json
{
  "access_token": "eyJhbGci...",
  "user": {
    "id": 1,
    "username": "admin",
    "nickname": "Super Admin",
    "role": "su",
    "rating": 1500,
    "preferred_language": ""
  }
}
```

同时在 Cookie 中设置 `refresh_token`（HttpOnly）。

---

### POST /auth/register — 注册

无需认证。**限流**：单个 IP 每小时仅可注册 1 次。

**请求体：**
```json
{
  "username": "newuser",
  "password": "123456",
  "nickname": "新用户"
}
```

**校验规则：** 用户名 3-32 字符不重复，密码至少 6 字符。

---

### POST /auth/refresh — 刷新 Token

无需认证，需携带 HttpOnly Cookie 中的 refresh_token。封禁用户和被强制登出用户的 refresh token 会被拒绝并删除。

---

### POST /auth/logout — 退出登录

需认证。删除所有 refresh_token 并清除 Cookie。

---

### POST /auth/change-password — 修改密码

需认证。修改后所有 refresh_token 失效。

**请求体：**
```json
{ "old_password": "旧密码", "new_password": "新密码" }
```

---

## 2. 题目模块 `/problems`

### GET /problems — 题目列表

无需认证。支持分页、搜索和标签筛选。

### GET /problems/:id — 题目详情

非公开题目需教师权限。返回题目描述（支持 Markdown）、提供者等。

### POST /problems — 创建题目

需教师权限。支持 `provider`（提供者）、`sample_input`（输入样例）、`sample_output`（输出样例）字段。

### PUT /problems/:id — 更新题目

需教师权限。不能更新已在比赛中的题目。

### DELETE /problems/:id — 删除题目

需教师权限。级联删除测试点、分组、提交记录。编号自动回收。

### POST /problems/:id/testcases — 添加测试点

需教师权限。批量添加内联测试点。

### PUT /problems/:id/testcases/:tcid — 更新测试点

### DELETE /problems/:id/testcases/:tcid — 删除单个测试点

### DELETE /problems/:id/testcases — 删除所有测试点

### GET /problems/:id/testdata — 查看测试点列表

### POST /problems/:id/testdata — 上传测试数据文件

multipart/form-data，字段名 `files`，文件命名 `name.in`/`name.out`。

### POST /problems/:id/testdata-zip — 上传ZIP测试数据

需教师权限。multipart/form-data，字段名 `file`，上传 `.zip` 文件。

**ZIP 结构说明：**
```
├── Script.txt           # 题目级计分脚本（可选）
├── 1.in / 1.out         # 根目录测试点（无分组）
├── subtask1/            # 文件夹名作为 Subtask ID
│   ├── Require.txt      # 依赖的 Subtask 名称（空格或换行分隔）
│   ├── Script.txt       # Subtask 级计分脚本（可选）
│   ├── a.in / a.out     # 测试点
│   └── b.in / b.out
├── subtask2/
│   ├── Require.txt      # 依赖 subtask1
│   └── c.in / c.out
```

- 测试点文件：`name.in` + `name.out` 或 `name.ans`
- `Require.txt`：空格或换行分隔依赖的 Subtask 名称
- 上传会清空原有测试数据并重建

### POST /problems/:id/groups — 创建测试分组

需教师权限。

**请求体：**
```json
{
  "subtask_id": "st1",
  "score": 30,
  "aggregator": "sum",
  "dependency": [],
  "scoring_script": ""
}
```

### PUT /problems/:id/groups/:gid — 更新测试分组

### DELETE /problems/:id/groups/:gid — 删除测试分组

### PUT /problems/:id/scoring-script — 设置题目级计分脚本

### PUT /problems/:id/testcases/:tcid/group — 设置测试点所属分组

### GET /problems/:id/solutions — 获取题目题解列表

### POST /problems/:id/solutions — 链接文章为题解

### DELETE /problems/:id/solutions/:sid — 移除题解

---

## 2.5 标签模块 `/tags`

### GET /tags — 标签列表

返回所有标签，按名称排序。

### POST /tags — 创建标签

需教师权限。

**请求体：**
```json
{
  "name": "动态规划",
  "color": "#6366f1"
}
```

### PUT /tags/:id — 更新标签

需教师权限。

### DELETE /tags/:id — 删除标签

需教师权限。级联删除关联关系。

### GET /tags/problem/:problemId — 获取题目标签

返回指定题目的所有标签。

### POST /tags/problem/:problemId — 设置题目标签

需教师权限。替换题目的所有标签。

**请求体：**
```json
{
  "tag_ids": [1, 2, 3]
}
```

---

## 3. 提交模块 `/submissions`

### GET /submissions — 提交列表

需认证。普通用户只能看自己的。支持 `user_id`、`problem_id`、`status` 筛选。

### GET /submissions/:id — 提交详情

需认证。包含详细错误说明和每个测试点的内存使用量。

### POST /submissions — 提交代码

需认证，有速率限制。源代码上限 128KB (131072 字符)。

**提交锁**：有未完成提交（pending_review/pending/running/compiling/judging）时禁止再次提交，返回 429。超级管理员和特权用户（`submit_lock_exempt`）豁免。

**提交流程：**
1. 创建提交记录，状态为 `pending_review`
2. 立即返回 `submission_id`
3. 后台异步 AI 安全审查
4. 审查通过 → 状态改为 `pending` → 入队编译运行
5. 审查不通过 → 封禁用户 + 状态 `system_error`

### GET /submissions/:id/detail — 提交详细信息

### POST /submissions/:id/rejudge — 重测提交

需教师权限。

### DELETE /submissions/:id — 删除提交

需管理员权限。编号自动回收。

---

## 4. 在线编程模块 `/ide`

### GET /ide/languages — 获取可用语言列表

### POST /ide/review — 代码安全审查

用于前端状态显示（"审查中..."），不控制实际逻辑。`/ide/run` 始终自己审查。

**请求体：**
```json
{
  "language": "cpp",
  "source_code": "#include..."
}
```

**响应：**
```json
{
  "safe": true,
  "reason": "...",
  "threat_level": "none"
}
```

### POST /ide/run — 运行代码（队列模式）

需认证，有速率限制。审查通过后入队编译运行。

**请求体：**
```json
{
  "language": "cpp",
  "source_code": "#include...",
  "stdin": "1 2"
}
```

**响应：**
```json
{
  "run_id": 1,
  "status": "pending"
}
```

### GET /ide/run/:id — 查询运行状态

轮询此接口获取运行结果。

**响应：**
```json
{
  "id": 1,
  "status": "accepted",
  "stdout": "3",
  "stderr": "",
  "compile_output": "",
  "exit_code": 0,
  "time_used": 12,
  "memory_used": 3200,
  "language": "cpp",
  "created_at": "2026-07-19 12:00:00"
}
```

状态流转：`pending` → `compiling` → `running` → `accepted`/`compile_error`/`runtime_error`

---

## 5. 用户管理模块 `/users`

### GET /users/rating — Rating 排行榜

无需认证。按 Rating 降序排列。

### GET /users/online — 在线用户列表

需管理员权限。返回 5 分钟内活跃用户。

### GET /users — 用户列表

需管理员权限。返回 Rating 和 provider 字段。

### GET /users/me — 获取当前用户信息

需认证。返回 `preferred_language`、`force_logout_at` 等字段。

### PUT /users/me — 更新个人资料

需认证。可更新 `nickname`、`signature`（1000字限制）、`bio`（Markdown）、`preferred_language`。

### PUT /users/:id/role — 修改角色

需超级管理员权限。不能修改自己的角色，不能降级另一个超级管理员。

### POST /users/:id/ban — 封禁用户

需管理员权限。封禁时踢出登录，设置 `force_logout_at` 使 Access Token 立即失效。

### POST /users/:id/unban — 解封用户

### POST /users/:id/force-logout — 强制登出

需管理员权限。删除 refresh_token + 设置 `force_logout_at`，Access Token 立即失效。

### POST /users/:id/reset-password — 重置密码

需超级管理员权限。

### PUT /users/:id/rating — 修改 Rating

需超级管理员权限。

### PUT /users/:id/submit-lock-exempt — 设置提交锁豁免

需超级管理员权限。设置用户免提交等待限制。

**请求体：**
```json
{ "submit_lock_exempt": true }
```

### POST /users/sudo-login — 免密登录

需超级管理员权限。以指定用户身份生成 Token。

### POST /users — 创建用户

需超级管理员权限。

### DELETE /users/:id — 删除用户

需超级管理员权限。不能删除最后一个超级管理员。

---

## 6. 语言管理模块 `/languages`（仅超级管理员）

### GET /languages — 语言列表

无需认证。

### POST /languages — 添加语言

需超级管理员权限。

### PUT /languages/:id — 更新语言

需超级管理员权限。

### DELETE /languages/:id — 删除语言

需超级管理员权限。

---

## 7. 比赛模块 `/contests`

### GET /contests — 比赛列表

### GET /contests/:id — 比赛详情

包含参赛人数。

### POST /contests — 创建比赛

### PUT /contests/:id — 更新比赛

### DELETE /contests/:id — 删除比赛

### POST /contests/:id/problems — 添加题目到比赛

### DELETE /contests/:id/problems/:pid — 从比赛中移除题目

### POST /contests/:id/invite — 邀请用户参赛

需教师权限。

### POST /contests/:id/join — 加入比赛

### GET /contests/:id/participants — 参赛用户列表

需教师权限。

### DELETE /contests/:id/participants/:uid — 移除参赛用户

### GET /contests/:id/leaderboard — 比赛排行榜

按总分降序、耗时升序排列。

---

## 8. 文章模块 `/articles`

### GET /articles — 文章列表

教师+可见所有文章（含未发布），普通用户仅见已发布。

### GET /articles/:id — 文章详情

### POST /articles — 发布文章

需教师权限。支持 `is_published` 控制是否发布。

### PUT /articles/:id — 编辑文章

### DELETE /articles/:id — 删除文章

---

## 9. 文件上传模块 `/uploads`（仅教师及以上）

### GET /uploads — 文件列表

需认证（教师+）。普通用户只能看自己的文件。

### POST /uploads — 上传文件

需认证（教师+）。multipart/form-data，字段名 `file`。最大 10MB，单用户最大 2GB。

### GET /uploads/:filename — 访问文件

无需认证。

### DELETE /uploads/:id — 删除文件

需管理员权限。

---

## 10. 统计接口 `/stats`

### GET /stats — 首页统计数据

返回题目数、提交数、用户数、语言数。

---

## 自定义计分脚本

计分脚本用于自定义测试点组或整题的评分逻辑。

### 语法

**语句**：以分号 `;` 分隔。

**变量**：以 `@` 开头，如 `@total_score`、`@status1`。

**赋值**：`@var = value;`

**算术运算**：`+`、`-`、`*`、`/`、`%`

**位运算**：`and`、`or`、`not`、`xor`

**比较运算**：`==`、`!=`、`>=`、`<=`、`>`、`<`

**逻辑运算**：`and`、`or`、`not`（在条件语句中）

**条件括号**：条件表达式支持 `()`，例如 `if (cond1 and cond2) or cond3; then ... fi`

**内置函数**：
- `min(a, b)` — 取最小值
- `max(a, b)` — 取最大值
- `abs(a)` — 取绝对值

**条件语句**：
```
if 条件; then
    语句;
else
    语句;
fi
```

### 常量

测试点：`AC`(1)、`WA`(2)、`TLE`(3)、`MLE`(4)

Subtask/整题：`AC`(1)、`UNAC`(2)

### 传入变量

`@statusX`、`@scoreX`、`@timeX`、`@memoryX`（X 为测试点/Subtask ID）

### 需定义变量

`@total_score`、`@final_status`、`@final_time`、`@final_memory`

### 示例

```
if (@status4==AC) and (@status3==AC or @status5==AC); then
    @total_score = 30;
    @final_status = AC;
    @final_time = @time4;
    @final_memory = @memory4;
else
    @total_score = 0;
    @final_status = UNAC;
fi
```

```
@total_score = min(@score1 + @score2, 30);
@final_time = max(@time1, @time2);
@final_memory = abs(@memory1 - @memory2);
```

---

## Markdown 增强语法

在题目描述、文章、个人简介等所有支持 Markdown 的页面中可用：

| 语法 | 效果 | 示例 |
|------|------|------|
| `$E=mc^2$` | 行内数学公式 | `$E=mc^2$` |
| `$$\sum_{i=1}^{n} i$$` | 块级数学公式 | `$$\sum_{i=1}^{n} i$$` |
| `@[bilibili](BV号)` | 嵌入 Bilibili 视频 | `@[bilibili](BV1xx411c7mD)` |
| `@[url](URL)` | 嵌入任意网站 iframe | `@[url](https://example.com)` |
| `@[audio](URL)` | 嵌入音频播放器 | `@[audio](https://example.com/song.mp3)` |
| `@[video](URL)` | 嵌入视频播放器 | `@[video](https://example.com/video.mp4)` |

---

## 前端页面

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/pages/index.html` | 系统介绍、统计信息 |
| 题库 | `/pages/problems.html` | 题目列表、搜索、标签筛选 |
| 题目详情 | `/pages/problem.html?id=X` | Markdown 题面、题解、嵌入媒体 |
| 提交代码 | `/pages/submit.html?id=X` | 代码编辑器、自动选中偏好语言 |
| 提交记录 | `/pages/submissions.html` | 提交历史列表 |
| 提交详情 | `/pages/submission.html?id=X` | 评测详情、错误说明、重测、每点内存 |
| 在线编程 | `/pages/ide.html` | IDE（需登录，三阶段状态，内存检测） |
| 比赛 | `/pages/contests.html` | 比赛列表 |
| 比赛详情 | `/pages/contest.html?id=X` | 题目列表、排行榜 |
| 文章 | `/pages/articles.html` | 文章列表 |
| 文章详情 | `/pages/article.html?id=X` | Markdown 文章 |
| 文章编辑 | `/pages/article-edit.html` | 发布/编辑文章 |
| 个人资料 | `/pages/profile.html` | 签名、简介、偏好语言、编辑 |
| Rating 排行 | `/pages/rating.html` | Rating 排行榜 |
| 图床 | `/pages/upload.html` | 文件上传、URL 复制（仅教师+） |
| 管理面板 | `/pages/admin.html` | 题目/用户/文章/文件/比赛管理 |
| 语言管理 | `/pages/languages.html` | 动态语言配置 |
| 登录 | `/pages/login.html` | 用户登录 |
| 注册 | `/pages/register.html` | 用户注册 |
