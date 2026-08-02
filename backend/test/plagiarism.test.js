// 功能10 代码查重 - 端到端测试
// 验证：算法 + API + 数据库
// 运行：node backend/test/plagiarism.test.js
const db = require('../database/db');

(async () => {
  await new Promise((resolve) => {
    const { initDB } = require('../database/db');
    initDB().then(resolve);
  });

  console.log('\n=== 功能10 代码查重 测试 ===\n');

  // 1. 单元测试：tokenize 与 jaccardSimilarity
  const { tokenize, jaccardSimilarity, levelOf, MIN_TOKEN_COUNT } = require('../services/plagiarism');

  // 1.1 注释剥离：C++ 风格
  const cpp1 = `
    // 这是一个注释
    #include <iostream>
    using namespace std;
    int main() {
        /* 块注释 */
        int n, m;
        cin >> n >> m;
        cout << n + m << endl;
        return 0;
    }
  `;
  const tokens1 = tokenize(cpp1, 'cpp');
  console.log(`[1.1] C++ tokenize: ${tokens1.length} tokens`);
  console.log(`      样例 tokens: ${tokens1.slice(0, 10).join(' ')}`);

  // 1.2 注释剥离：Python 风格
  const py1 = `
# Python comment
def add(a, b):
    """docstring"""
    return a + b

print(add(1, 2))
  `;
  const tokensPy = tokenize(py1, 'python3');
  console.log(`[1.2] Python tokenize: ${tokensPy.length} tokens`);
  console.log(`      样例 tokens: ${tokensPy.join(' ')}`);

  // 1.3 Jaccard 相似度 - 使用足够长的代码（>= 50 token 才会被查重任务处理）
  const codeA = `
    #include <iostream>
    #include <vector>
    #include <algorithm>
    using namespace std;
    int main() {
        int n;
        cin >> n;
        vector<int> arr(n);
        for (int i = 0; i < n; i++) {
            cin >> arr[i];
        }
        sort(arr.begin(), arr.end());
        long long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += arr[i];
        }
        cout << sum << endl;
        for (int i = 0; i < n; i++) {
            cout << arr[i] << " ";
        }
        cout << endl;
        return 0;
    }
  `;
  // B 与 A 仅注释不同，代码完全相同（典型复制粘贴场景，应高度相似）
  const codeB = `
    // 这是一个排序求和题的解答
    #include <iostream>  // IO
    #include <vector>    // 动态数组
    #include <algorithm> // 排序
    using namespace std;
    int main() {
        int n;
        cin >> n;
        vector<int> arr(n);
        for (int i = 0; i < n; i++) {
            cin >> arr[i];
        }
        sort(arr.begin(), arr.end());
        long long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += arr[i];
        }
        cout << sum << endl;
        for (int i = 0; i < n; i++) {
            cout << arr[i] << " ";
        }
        cout << endl;
        return 0;
    }
  `;
  // 多个变量名不同：n->count, arr->data, sum->total, i->j。变量名保留情况下应低于 B
  const codeB2 = `
    #include <iostream>
    #include <vector>
    #include <algorithm>
    using namespace std;
    int main() {
        int count;
        cin >> count;
        vector<int> data(count);
        for (int j = 0; j < count; j++) {
            cin >> data[j];
        }
        sort(data.begin(), data.end());
        long long total = 0;
        for (int j = 0; j < count; j++) {
            total += data[j];
        }
        cout << total << endl;
        for (int j = 0; j < count; j++) {
            cout << data[j] << " ";
        }
        cout << endl;
        return 0;
    }
  `;
  const codeC = `
    #include <cstdio>
    #include <map>
    using namespace std;
    int main() {
        int n;
        scanf("%d", &n);
        map<int, int> freq;
        for (int i = 0; i < n; i++) {
            int x;
            scanf("%d", &x);
            freq[x]++;
        }
        long long result = 0;
        for (auto& p : freq) {
            result += (long long)p.first * p.second;
        }
        printf("%lld\\n", result);
        return 0;
    }
  `;
  const tA = tokenize(codeA, 'cpp');
  const tB = tokenize(codeB, 'cpp');
  const tB2 = tokenize(codeB2, 'cpp');
  const tC = tokenize(codeC, 'cpp');
  const simAB = jaccardSimilarity(tA, tB);
  const simAB2 = jaccardSimilarity(tA, tB2);
  const simAC = jaccardSimilarity(tA, tC);
  console.log(`[1.3] Jaccard:`);
  console.log(`      A vs B  (仅注释不同，应高度相似): ${(simAB*100).toFixed(1)}% - ${levelOf(simAB)}`);
  console.log(`      A vs B2 (仅变量名不同，应中等相似): ${(simAB2*100).toFixed(1)}% - ${levelOf(simAB2)}`);
  console.log(`      A vs C  (完全不同实现，应低相似): ${(simAC*100).toFixed(1)}% - ${levelOf(simAC)}`);

  // 1.4 短代码跳过阈值
  const shortCode = 'int main(){return 0;}';
  const tShort = tokenize(shortCode, 'cpp');
  console.log(`[1.4] 短代码 token 数: ${tShort.length}, MIN_TOKEN_COUNT=${MIN_TOKEN_COUNT}, 跳过: ${tShort.length < MIN_TOKEN_COUNT}`);

  // 2. 集成测试：插入 3 个用户、3 份提交，跑查重任务
  console.log('\n--- 集成测试：插入测试数据 ---');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // 创建 4 个测试用户（A、B、B2、C），覆盖 high / medium / low 三个等级
  const bcrypt = require('bcryptjs');
  const testUsers = [
    { username: 'plag_test_a', nickname: '测试用户A', code: codeA },
    { username: 'plag_test_b', nickname: '测试用户B', code: codeB },
    { username: 'plag_test_b2', nickname: '测试用户B2', code: codeB2 },
    { username: 'plag_test_c', nickname: '测试用户C', code: codeC }
  ];
  const userIds = [];
  for (const u of testUsers) {
    const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    let uid;
    if (exist) {
      uid = exist.id;
    } else {
      const hash = bcrypt.hashSync('test123', 10);
      const r = db.prepare('INSERT INTO users (username, nickname, password_hash, role, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(u.username, u.nickname, hash, 'user', 1500, now);
      uid = r.lastInsertRowid;
    }
    userIds.push(uid);
    console.log(`  用户 ${u.username} => id=${uid}`);

    // 插入提交（status='accepted' 让查重能取到）
    db.prepare('DELETE FROM submissions WHERE user_id = ? AND problem_id = 1').run(uid);
    const subId = db.findNextId('submissions');
    db.prepare('INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      subId, uid, 1, 'cpp', u.code, 'accepted', 100, now
    );
    console.log(`  插入提交 #${subId} (用户 ${u.username})`);
  }

  // 3. 触发查重任务
  console.log('\n--- 触发查重 ---');
  const { createTask, getTask } = require('../services/plagiarism');
  const taskId = createTask(1, 1);
  console.log(`任务已创建: #${taskId}`);

  // 等待异步任务完成
  await new Promise(resolve => setTimeout(resolve, 500));

  const task = getTask(taskId);
  console.log(`状态: ${task.status}`);
  console.log(`总对数: ${task.total_pairs}, 已检查: ${task.checked_pairs}`);
  console.log(`发现相似对: ${task.pairs.length}`);
  for (const p of task.pairs) {
    console.log(`  - pair #${p.id}: 用户 ${p.user_a_name} vs ${p.user_b_name}, 相似度 ${(p.similarity*100).toFixed(1)}% [${p.level}]`);
  }

  // 4. 验证结果
  console.log('\n--- 验证 ---');
  let pass = true;
  if (task.status !== 'done') { console.log('✗ 任务未完成'); pass = false; }
  // 4 个用户两两组合 = 6 对
  if (task.total_pairs !== 6) { console.log(`✗ 总对数应为 6, 实际 ${task.total_pairs}`); pass = false; }
  else { console.log(`✓ 总对数 = 6`); }
  if (task.pairs.length < 2) { console.log('✗ 应至少发现 2 对相似（A-B high, A-B2 medium）'); pass = false; }

  // A vs B 应高度相似（仅注释不同 → token 完全相同）
  const abPair = task.pairs.find(p =>
    (p.user_a === userIds[0] && p.user_b === userIds[1]) ||
    (p.user_a === userIds[1] && p.user_b === userIds[0])
  );
  if (!abPair) { console.log('✗ 未找到 A vs B 相似对'); pass = false; }
  else if (abPair.level !== 'high') { console.log(`✗ A vs B 应为 high, 实际 ${abPair.level} (${(abPair.similarity*100).toFixed(1)}%)`); pass = false; }
  else { console.log(`✓ A vs B 相似度 ${(abPair.similarity*100).toFixed(1)}% [high]`); }

  // A vs B2 应为 medium（变量名 n,m vs a,b 不同）
  const ab2Pair = task.pairs.find(p =>
    (p.user_a === userIds[0] && p.user_b === userIds[2]) ||
    (p.user_a === userIds[2] && p.user_b === userIds[0])
  );
  if (!ab2Pair) { console.log('✗ 未找到 A vs B2 相似对'); pass = false; }
  else if (ab2Pair.level !== 'medium') { console.log(`✗ A vs B2 应为 medium, 实际 ${ab2Pair.level} (${(ab2Pair.similarity*100).toFixed(1)}%)`); pass = false; }
  else { console.log(`✓ A vs B2 相似度 ${(ab2Pair.similarity*100).toFixed(1)}% [medium]`); }

  // A vs C 不应出现在结果中（相似度 < 0.7）
  const acPair = task.pairs.find(p =>
    (p.user_a === userIds[0] && p.user_b === userIds[3]) ||
    (p.user_a === userIds[3] && p.user_b === userIds[0])
  );
  if (acPair) { console.log(`✗ A vs C 不应出现在结果中 (相似度 ${(acPair.similarity*100).toFixed(1)}%)`); pass = false; }
  else { console.log('✓ A vs C 相似度低于阈值，未出现在结果中'); }

  // 5. 验证 pair 详情（高亮 token）
  if (abPair) {
    const { getPairDetail } = require('../services/plagiarism');
    const detail = getPairDetail(abPair.id);
    console.log(`\n--- pair 详情 ---`);
    console.log(`code_a 长度: ${detail.code_a.length}, code_b 长度: ${detail.code_b.length}`);
    console.log(`tokens_a 数量: ${detail.tokens_a.length}, tokens_b 数量: ${detail.tokens_b.length}`);
    console.log(`共享 token 数量: ${detail.shared_tokens.length}`);
    console.log(`共享 token 样例: ${detail.shared_tokens.slice(0, 15).join(' ')}`);
    if (detail.shared_tokens.length > 0) {
      console.log('✓ 共享 token 计算正确');
    } else {
      console.log('✗ 共享 token 为空');
      pass = false;
    }
  }

  // 清理测试数据
  console.log('\n--- 清理测试数据 ---');
  for (const uid of userIds) {
    db.prepare('DELETE FROM submissions WHERE user_id = ? AND problem_id = 1').run(uid);
  }
  db.prepare('DELETE FROM plagiarism_pairs WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM plagiarism_tasks WHERE id = ?').run(taskId);
  for (const u of testUsers) {
    db.prepare('DELETE FROM users WHERE username = ?').run(u.username);
  }
  console.log('已清理测试用户、提交、查重任务');

  console.log(`\n=== 测试结果: ${pass ? '✓ 全部通过' : '✗ 存在失败'} ===\n`);
  process.exit(pass ? 0 : 1);
})();
