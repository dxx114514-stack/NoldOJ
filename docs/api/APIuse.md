# NoldOJ API 接口文档

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

提交代码时自动调用配置的 AI 服务（默认 `localhost:11434`，模型 `qwen3:1.7b`）进行安全审查。发现恶意代码将自动封禁用户。代码少于 50 字符跳过审查。源代码上限 128KB (131072 字符)。

**提示词注入防护**：15 种注入模式检测、代码截断脱敏、AI 响应操纵检测。

可通过 `config/ai.txt` 配置：
- `AI_ENABLED` — 启用/禁用 AI 审查
- `URL` — AI 服务 API 地址
- `MODEL` — 审查模型名称
- `KEY` — API Key（可选）

---

## 1. 认证模块 `/auth`

### GET /auth/captcha — 获取图形验证码

无需认证。返回验证码 id + SVG 图像（`svg-captcha`），用于登录/注册。在 `config` 中禁用验证码时返回 404。

**响应：**
```json
{
  "captcha_id": "xxx",
  "svg": "<svg>...</svg>"
}
```

### POST /auth/send-code — 发送邮箱验证码

无需认证（有邮件限流）。向注册邮箱发送验证码，用于邮箱校验。

**请求体：**
```json
{ "email": "user@example.com" }
```

### POST /auth/verify-code — 校验邮箱验证码

无需认证（有限流）。校验 `email_codes` 表中的验证码，通过后标记邮箱已验证。

**请求体：**
```json
{ "email": "user@example.com", "code": "123456" }
```

### GET /auth/email-enabled — 查询邮箱功能是否启用

无需认证。返回邮箱注册/验证功能是否开启。

### POST /auth/login — 登录

无需认证。封禁用户无法登录。

**请求体：**
```json
{
  "username": "admin",
  "password": "<初始密码，见控制台日志>"
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

**多样例（R12-1）**：可传 `samples` 数组，每项 `{ input: string, output: string, note?: string }`（note 为可选说明，≤500 字符；input/output ≤64KB）。传入后全量写入并以首条同步旧 `sample_input`/`sample_output` 字段。不传则沿用旧单样例字段。

```json
{
  "title": "A+B Problem",
  "samples": [
    { "input": "1 2\n", "output": "3\n", "note": "最小数据" },
    { "input": "100 200\n", "output": "300\n" }
  ]
}
```

### GET /problems/:id — 题目详情

返回体含 `samples` 数组（按 sort_order 排序）。兼容旧数据：无多样例记录时由旧字段构造单元素数组。

### PUT /problems/:id — 更新题目

需教师权限。不能更新已在比赛中的题目。

`samples` 数组语义：
- **传数组（含空数组）**：全量替换该题样例，首条双写旧字段
- **不传**：不影响样例；若单独更新 `sample_input`/`sample_output`，会同步覆盖新表首条

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

### POST /problems/:id/ai-testdata — AI 生成测试数据

需教师权限。自动为题目生成测试用例（正常 + 边界），参数：`samples`（1-10）、`edge_cases`（0-10）。详见上方「AI 测试数据生成」一节。

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

可选认证。教师/管理员可见全部；普通用户仅见已发布题解且隐藏正文内容。

### POST /problems/:id/solutions — 链接文章为题解

需教师权限。请求体：`article_id`、`sort_order`（可选）、`show_after_contest`（可选）。

### DELETE /problems/:id/solutions/:sid — 移除题解

需教师权限。

### GET /problems/:id/groups — 列出子任务分组

需教师权限。

### PUT /problems/:id/batch-testcases — 批量更新测试点

需教师权限。批量修改多个测试点的字段（输入/输出/分组等）。

### GET /problems/:id/discussions — 题目讨论列表

无需认证。分页返回该题目下的讨论帖列表（含回复数）。

### POST /problems/:id/plagiarism-check — 对题目发起代码查重

需教师权限。异步启动查重任务，返回 `task_id`。

**请求体：**
```json
{
  "threshold": 80,
  "min_submissions": 2,
  "start_time": "",
  "end_time": ""
}
```

### GET /problems/:id/plagiarism-report — 获取题目查重报告

需教师权限。返回该题查重任务结果（查重对列表）。

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

需认证。返回详细信息（用户只可看自己的）。

### GET /submissions/:id/diff — 与上次提交的代码对比

需认证。返回与上一次 AC/有效提交的代码 diff；WA 时附期望输出与实际输出。

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

### POST /problems/:id/hint — AI 提示（AI Hint）

需认证。学生对某题失败 2 次后可获取方向性算法提示（不给完整代码，300 字以内中文）。每用户每题 60 秒冷却。

**请求体：**
```json
{}
```

**响应：**
```json
{
  "hint": "建议考虑贪心策略..."
}
```

### POST /problems/:id/ai-testdata — AI 生成测试数据

需教师权限。为指定题目自动生成测试用例（正常用例 + 边界用例），自动写入磁盘。

**请求体：**
```json
{
  "samples": 3,
  "edge_cases": 3
}
```

- `samples`：正常用例数量（1-10，默认 3）
- `edge_cases`：边界用例数量（0-10，默认 3）

**响应：**
```json
{
  "test_cases": [
    { "name": "ai_1", "input": "...", "expected_output": "..." }
  ],
  "count": 6
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

### GET /users/:id/profile — 公开用户资料

无需认证。返回公开资料（签名、简介、Rating、三个隐私开关 `hide_achievements`/`hide_dashboard`/`hide_favorites` 等）。隐藏 Rating 的用户会隐藏 Rating。三个隐私开关字段供前端判断是否展示该用户的成就/看板/收藏入口。

### GET /users/me — 获取当前用户信息

需认证。返回 `preferred_language`、`force_logout_at`、`hide_achievements`、`hide_dashboard`、`hide_favorites` 等字段。

### GET /users/me/virtual-contests — 我的虚拟比赛列表

需认证。返回当前用户的虚拟比赛记录列表。

### PUT /users/me — 更新个人资料

需认证。可更新 `nickname`、`signature`（1000字限制）、`bio`（Markdown）、`hide_rating`、`preferred_language`，以及三个隐私开关 `hide_achievements`、`hide_dashboard`、`hide_favorites`（boolean，开启后对其它普通用户隐藏对应数据，admin/su 始终可见）。

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

### PUT /users/:id/hide-rating — 切换隐藏 Rating

需管理员权限。不能修改权限高于自己或同级用户的隐藏状态。

### PUT /users/:id/upload-limits — 设置上传限制

需超级管理员权限。设置用户上传大小/容量限制。

**请求体：**
```json
{ "max_upload_bytes": 10485760, "total_upload_bytes": 2147483648 }
```

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

### GET /users/register-enabled — 查询注册开关状态

需超级管理员权限。返回 `{ "enabled": true/false }`。

### PUT /users/register-enabled — 切换注册开关

需超级管理员权限。请求体 `{ "enabled": true/false }`（布尔值，必填）。

- 写入 `config/register.txt` 并热更新内存态，无需重启
- 关闭后 `POST /auth/register` 返回 403 `ERR_REGISTER_DISABLED` 且不消耗注册限流配额
- 超管通过 `POST /users` 创建账号不受此开关影响

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

按总分降序、耗时升序排列。可选认证（传 Token 可识别角色/参赛身份）：

- **参赛者 / teacher / admin / su**：返回完整排行榜（`leaderboard` 含 `rank`、`total_score`、`total_time`、各题得分）
- **非参赛者 / 未登录**：仅返回冻结状态，`leaderboard` 为空数组，不泄露排名
- 排行榜冻结时只统计冻结时刻之前的提交

### POST /contests/:id/unfreeze — 解除排行榜冻结

需管理员权限。解冻后广播给该比赛房间。

### GET /contests/:id/announcements — 比赛内公告列表

无需认证。返回该比赛的公告列表。

### POST /contests/:id/virtual-start — 发起虚拟参赛

需认证。为当前用户启动该比赛的虚拟参赛。

### POST /contests/:id/plagiarism-check — 对比赛所有题目一键查重

需教师权限。异步启动查重任务，返回 `task_id`。

### GET /contests/:id/discussions — 比赛讨论列表

无需认证。分页返回该比赛的讨论帖列表。

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

## 10.5 分类模块 `/categories`

### GET /categories — 分类列表

无需认证。返回所有分类（含题目数）。

### GET /categories/:id — 分类详情

无需认证。

### POST /categories — 创建分类

需管理员权限。

### PUT /categories/:id — 更新分类

需管理员权限。

### DELETE /categories/:id — 删除分类

需管理员权限。级联删除关联关系。

### POST /categories/:id/problems/:pid — 把题目加入分类

需教师权限。

### DELETE /categories/:id/problems/:pid — 把题目移出分类

需教师权限。

---

## 10.6 公告模块 `/announcements`

### GET /announcements — 公告列表

无需认证。支持 `type` 过滤，默认 global，置顶优先。

### GET /announcements/:id — 公告详情

无需认证。

### POST /announcements — 创建公告

需教师权限。global 公告通过 WebSocket 广播。

### PUT /announcements/:id — 更新公告

需教师权限。不能修改他人公告。

### DELETE /announcements/:id — 删除公告

需教师权限。不能删除他人公告。

---

## 10.7 题单模块 `/problem-sets`

### GET /problem-sets — 题单列表

无需认证。仅返回公开题单；登录用户携带进度。

### GET /problem-sets/:id — 题单详情

可选认证。私有题单仅创建者/admin/su 可见。

### GET /problem-sets/:id/progress — 当前用户解题进度

需认证。返回该题单中每道题的 AC 状态。

### POST /problem-sets — 创建题单

需教师权限。

### PUT /problem-sets/:id — 更新题单信息

需教师权限。可更新 `title`、`description`、`is_public`。

### PUT /problem-sets/:id/problems — 覆盖式设置题单题目列表

需教师权限。整体替换题单包含的题目。

**请求体：**
```json
{ "problemIds": [1, 2, 3] }
```

### DELETE /problem-sets/:id — 删除题单

需教师权限。级联删除条目与进度记录。

### POST /problem-sets/:id/progress/:pid — 标记题目已 AC

需认证。需该题存在 accepted 提交。

---

## 10.8 虚拟比赛模块 `/virtual-contests`

### GET /virtual-contests/:id — 虚拟比赛详情

需认证（仅本人或 admin/su）。返回题目、剩余时间、我的提交。

### GET /virtual-contests/:id/ranking — 本人排名数据

需认证（仅本人或 admin/su）。返回该虚拟比赛中本人各题得分与排名。

---

## 10.9 代码查重模块 `/plagiarism`

### GET /plagiarism/pairs/:pair_id — 查重对详情

需教师权限。返回两份代码并排展示 + 高亮 token。

### GET /plagiarism/:task_id — 查重任务进度/结果

需教师权限。返回任务状态、进度、查重对列表。

---

## 10.10 成就模块 `/achievements`

### GET /achievements — 成就列表

需认证。返回全部成就及指定用户的解锁状态。

| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | integer | 可选。指定查看的用户的成就。缺省查看当前登录用户本人。 |

**返回：**
```json
{
  "total": 10,
  "unlocked": 3,
  "achievements": [
    { "id": 1, "code": "first_ac", "name": "初见杀", "description": "...", "icon": "🎯", "unlocked": true, "unlocked_at": "2026-08-17 12:00:00" }
  ]
}
```

**隐私**：查看他人成就时，若目标用户开启了 `hide_achievements`，则非本人且非 admin/su 的访问返回 `403`。

### 错误码

- `401`：未登录
- `403`：目标用户已隐藏成就，且当前访问者非本人/admin/su
- `404`：user_id 对应的用户不存在
- `400`：user_id 格式非法

---

## 10.11 数据看板模块 `/statistics`

### GET /statistics/me/stats — 个人数据看板

需认证。返回提交日历（近 365 天）、语言分布、AC 题目难度分布、概览统计。

| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | integer | 可选。指定查看的用户的看板。缺省查看当前登录用户本人。 |

**返回：**
```json
{
  "overview": { "totalAccepted": 42, "totalSubmits": 100, "totalProblems": 20, "totalFavorites": 5, "achievements": 3 },
  "calendar": [ { "date": "2025-08-18", "submits": 3, "acs": 2 } ],
  "languages": [ { "language": "cpp", "submits": 60, "acs": 30 } ],
  "difficulty": [ { "difficulty": 1, "count": 8 } ]
}
```

**隐私**：查看他人看板时，若目标用户开启了 `hide_dashboard`，则非本人且非 admin/su 的访问返回 `403`。

### 错误码

- `401`：未登录
- `403`：目标用户已隐藏看板，且当前访问者非本人/admin/su
- `404`：user_id 对应的用户不存在
- `400`：user_id 格式非法

---

## 10.12 收藏模块 `/favorites`

### GET /favorites — 收藏列表

需认证。返回指定用户的收藏题目列表（分页）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | integer | 可选。指定查看的用户的收藏。缺省查看当前登录用户本人。 |
| `page` | integer | 页码，默认 1 |
| `size` | integer | 每页数量，默认 20，上限 50 |

**返回：**
```json
{
  "total": 5,
  "page": 1,
  "size": 20,
  "favorites": [
    { "problem_id": 1, "title": "A + B Problem", "difficulty": 1, "problem_type": "traditional", "created_at": "2026-08-17 12:00:00", "solved": true }
  ]
}
```

**隐私**：查看他人收藏时，若目标用户开启了 `hide_favorites`，则非本人且非 admin/su 的访问返回 `403`。

### GET /favorites/status — 批量检查收藏状态

需认证。查询当前登录用户是否收藏了指定题目。参数 `ids=1,2,3`（逗号分隔，最多 500 个）。

### POST /favorites/:problemId — 收藏题目

需认证。将指定题目加入当前登录用户的收藏。返回 `{ "favorited": true }`。

### DELETE /favorites/:problemId — 取消收藏

需认证。将指定题目移出当前登录用户的收藏。返回 `{ "favorited": false }`。

### 错误码

- `401`：未登录
- `403`：目标用户已隐藏收藏，且当前访问者非本人/admin/su
- `404`：user_id 对应的用户不存在，或收藏/取消收藏的题目不存在
- `400`：user_id 格式非法

---

## 11. 讨论模块 `/discussions`

### GET /discussions/:id — 讨论详情

返回讨论内容及楼中楼回复树（一级回复含 `children`，最多两层）。

### POST /discussions — 创建讨论

需登录。请求体：`problem_id` / `contest_id`（择一）、`title`、`content`。

### PUT /discussions/:id — 更新讨论

需登录（作者本人或 admin）。请求体字段：`title`、`content`、`pinned`、`locked`、`is_official`。

### DELETE /discussions/:id — 删除讨论

需登录（作者或 admin）。删除讨论及其全部回复。

### POST /discussions/:id/replies — 发表回复

需登录。请求体：`content`、`parent_id`（可选，二级回复指向一级回复 id）。

### DELETE /discussions/:id/replies/:rid — 删除回复

需登录（作者或 admin）。删除该回复时**级联删除其所有直接子回复**。

### PUT /discussions/:id/pin — 置顶/取消置顶

需教师及以上。请求体：`pinned`（boolean）。

### PUT /discussions/:id/lock — 锁定/解锁

需教师及以上。请求体：`locked`（boolean）。

### PUT /discussions/:id/official — 标记官方题解

需教师及以上。请求体：`is_official`（boolean）。

---

## 12. 系统端点（server.js 直接定义）

### GET /api/v1/health — 健康检查

无需认证。返回 `{ ok: true, ts: <时间戳> }`。

### GET /api/v1/stats — 平台统计

无需认证。返回 `{ problems, submissions, users, languages }`。

### GET /api/v1/jobs — 任务重定向

302 重定向到 `/api/v1/submissions`。

### GET /api/v1/jobs/:id — 任务详情重定向

302 重定向到 `/api/v1/submissions/:id`。

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
| 个人资料 | `/pages/profile.html?id=X` | 签名、简介、偏好语言、隐私开关编辑、成就/看板/收藏入口 |
| Rating 排行 | `/pages/rating.html` | Rating 排行榜 |
| 成就 | `/pages/achievements.html?user_id=X` | 我的/TA 的成就（user_id 缺省为本人） |
| 数据看板 | `/pages/dashboard.html?user_id=X` | 我的/TA 的数据看板（user_id 缺省为本人） |
| 我的收藏 | `/pages/favorites.html?user_id=X` | 我的/TA 的收藏（user_id 缺省为本人，他人视图无取消收藏） |
| 图床 | `/pages/upload.html` | 文件上传、URL 复制（仅教师+） |
| 管理面板 | `/pages/admin.html` | 题目/用户/文章/文件/比赛管理 |
| 语言管理 | `/pages/languages.html` | 动态语言配置 |
| 登录 | `/pages/login.html` | 用户登录 |
| 注册 | `/pages/register.html` | 用户注册 |

