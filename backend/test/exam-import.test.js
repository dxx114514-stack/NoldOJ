const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const XLSX = require(path.join(__dirname, '..', '..', 'frontend', 'js', 'xlsx.full.min.js'));
const importer = require(path.join(__dirname, '..', '..', 'frontend', 'js', 'exam-import.js'));

const HEADER = ['题型', '题目内容', '选项A', '选项B', '选项C', '选项D', '正确答案', '分值', '主观题', 'AI评分提示词'];

function toRow(type, title, opts, answer, score, subjective, ai) {
  return [type, title, opts[0] || '', opts[1] || '', opts[2] || '', opts[3] || '', answer, score, subjective, ai];
}

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '题目');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('Exam Excel import: parseRows', () => {
  it('按表头列名映射，输出与后端 questions 字段一致', () => {
    const rows = [HEADER,
      toRow('选择题', '1 + 1 = ?', ['1', '2', '3', '4'], 'B', '10', '', ''),
      toRow('判断题', '2 是质数', [], '错', '5', '', ''),
      toRow('填空题', '3 的平方是__', [], '9', '5', '', ''),
      toRow('大题', '证明题干', [], '', '20', '是', '按步骤给分')
    ];
    const res = importer.parseRows(rows);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions.length, 4);

    const [c, t, f, l] = res.questions;
    assert.deepEqual(c, {
      question_type: 'choice', title: '1 + 1 = ?', options: ['1', '2', '3', '4'],
      correct_answer: 'B', score: 10, is_subjective: 0, ai_grading_prompt: ''
    });
    assert.equal(t.question_type, 'true_false');
    assert.equal(t.correct_answer, 'false');
    assert.equal(t.score, 5);
    assert.equal(f.question_type, 'fill_blank');
    assert.equal(f.correct_answer, '9');
    assert.equal(l.question_type, 'long_answer');
    assert.equal(l.is_subjective, 1);
    assert.equal(l.ai_grading_prompt, '按步骤给分');
    assert.equal(l.correct_answer, '');
  });

  it('没有表头时按固定列序读取', () => {
    const rows = [toRow('选择题', '题目', ['甲', '乙'], 'A', '8', '', '')];
    const res = importer.parseRows(rows);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions.length, 1);
    assert.equal(res.questions[0].options.length, 2);
    assert.equal(res.questions[0].score, 8);
  });

  it('识别中英文题型别名', () => {
    const cases = [
      ['单选题', 'choice'], ['选择', 'choice'], ['true_false', 'true_false'],
      ['是非题', 'true_false'], ['填空', 'fill_blank'], ['简答题', 'long_answer'],
      ['主观题', 'long_answer'], ['大题', 'long_answer']
    ];
    cases.forEach(([raw, expect]) => {
      const res = importer.parseRows([HEADER, toRow(raw, '题干', ['a', 'b'], expect === 'choice' ? 'A' : (expect === 'true_false' ? '对' : 'x'), '1', '', '')]);
      assert.deepEqual(res.errors, [], '题型 ' + raw + ' 应被识别');
      assert.equal(res.questions[0].question_type, expect, '题型 ' + raw);
    });
  });

  it('选择题答案规范化：字母、带括号/句点、选项文本都能识别', () => {
    const answers = ['A', '（C）', 'b.', '2'];
    answers.forEach((ans) => {
      const rows = [HEADER, toRow('选择题', '题干', ['1', '2', '3', '4'], ans, '5', '', '')];
      const res = importer.parseRows(rows);
      assert.deepEqual(res.errors, [], '答案 ' + ans);
      const expect = ans === '2' ? 'B' : ans.replace(/[（）.]/g, '').toUpperCase();
      assert.equal(res.questions[0].correct_answer, expect, '答案 ' + ans);
    });
  });

  it('选择题答案不合法时报错并跳过该行', () => {
    const bad = ['AC', 'E', '不知道'];
    bad.forEach((ans) => {
      const res = importer.parseRows([HEADER, toRow('选择题', '题干', ['甲', '乙', '丙', '丁'], ans, '5', '', '')]);
      assert.equal(res.questions.length, 0, '答案 ' + ans + ' 不应导入');
      assert.equal(res.errors.length, 1);
      assert.match(res.errors[0], /第 2 行：/);
    });
  });

  it('判断题答案兼容 对/错、true/false、1/0、√/×', () => {
    const map = { '对': 'true', '正确': 'true', 'TRUE': 'true', '1': 'true', '√': 'true', '错': 'false', '错误': 'false', '0': 'false', '×': 'false' };
    Object.keys(map).forEach((ans) => {
      const res = importer.parseRows([HEADER, toRow('判断题', '题干', [], ans, '5', '', '')]);
      assert.deepEqual(res.errors, [], '判断题答案 ' + ans);
      assert.equal(res.questions[0].correct_answer, map[ans], '判断题答案 ' + ans);
    });
    const res = importer.parseRows([HEADER, toRow('判断题', '题干', [], '也许', '5', '', '')]);
    assert.equal(res.questions.length, 0);
    assert.match(res.errors[0], /判断题须为/);
  });

  it('选项列乱序时按标签字母排序，保证答案字母指对选项', () => {
    const rows = [
      ['题型', '题目内容', '选项B', '选项A', '正确答案', '分值'],
      ['选择题', '题干', '乙的文本', '甲的文本', 'A', '5']
    ];
    const res = importer.parseRows(rows);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.questions[0].options, ['甲的文本', '乙的文本']);
    assert.equal(res.questions[0].correct_answer, 'A');
  });

  it('单个「选项」列支持换行/竖线分隔多个选项', () => {
    const rows = [
      ['题型', '题目内容', '选项', '正确答案', '分值'],
      ['选择题', '题干', '甲\n乙|丙', 'C', '5']
    ];
    const res = importer.parseRows(rows);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.questions[0].options, ['甲', '乙', '丙']);
    assert.equal(res.questions[0].correct_answer, 'C');
  });

  it('分值缺省 5，非法分值报错', () => {
    const rows = [HEADER,
      toRow('判断题', '有分值', [], '对', '7', '', ''),
      toRow('判断题', '无分值', [], '对', '', '', ''),
      toRow('判断题', '坏分值', [], '对', '十', '', '')
    ];
    const res = importer.parseRows(rows);
    assert.equal(res.questions.length, 2);
    assert.equal(res.questions[0].score, 7);
    assert.equal(res.questions[1].score, 5);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /分值必须是非负数字/);
  });

  it('空行与重复表头行被跳过，缺题面/缺选项报错', () => {
    const rows = [HEADER,
      ['', '', '', '', '', '', '', '', '', ''],
      HEADER,
      ['选择题', '', '甲', '乙', '', '', 'A', '5', '', ''],
      ['选择题', '题干', '只有甲', '', '', '', 'A', '5', '', '']
    ];
    const res = importer.parseRows(rows);
    assert.equal(res.questions.length, 0);
    assert.equal(res.errors.length, 2);
    assert.match(res.errors[0], /第 4 行：题目内容为空/);
    assert.match(res.errors[1], /第 5 行：选择题至少需要 2 个非空选项/);
  });

  it('主观题列生效，大题强制主观', () => {
    const rows = [HEADER,
      toRow('填空题', '主观填空', [], '参考答案', '5', '是', '评分要点'),
      toRow('填空题', '客观填空', [], 'x', '5', '', ''),
      toRow('大题', '大题', [], '', '5', '', '')
    ];
    const res = importer.parseRows(rows);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions[0].is_subjective, 1);
    assert.equal(res.questions[1].is_subjective, 0);
    assert.equal(res.questions[2].is_subjective, 1);
  });

  it('写入 xlsx 再读回，解析结果一致（SheetJS 往返）', () => {
    const rows = [HEADER,
      toRow('选择题', '往返题', ['a', 'b', 'c', 'd'], 'A', '10', '', ''),
      toRow('判断题', '往返判断', [], '对', '5', '', '')
    ];
    const buf = workbookBuffer(rows);
    const res = importer.importBuffer(buf, XLSX);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions.length, 2);
    assert.equal(res.questions[0].question_type, 'choice');
    assert.deepEqual(res.questions[0].options, ['a', 'b', 'c', 'd']);
    assert.equal(res.questions[0].correct_answer, 'A');
    assert.equal(res.questions[0].score, 10);
    assert.equal(res.questions[1].correct_answer, 'true');
  });

  it('模板本身可被完整解析', () => {
    const buf = workbookBuffer([importer.HEADER].concat(importer.SAMPLE_ROWS));
    const res = importer.importBuffer(buf, XLSX);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions.length, importer.SAMPLE_ROWS.length);
    assert.equal(res.questions.filter((q) => q.question_type === 'choice').length, 1);
    assert.equal(res.questions.filter((q) => q.is_subjective).length, 2);
  });

  it('站内示例文件 exam-sample.xlsx 存在、可解析且与表头保持同步', () => {
    const file = path.join(__dirname, '..', '..', 'frontend', 'pages', 'exam-sample.xlsx');
    assert.ok(fs.existsSync(file), '示例文件缺失: ' + file);
    const buf = fs.readFileSync(file);
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.deepEqual(wb.SheetNames, ['试卷题目', '填写说明']);
    const res = importer.importBuffer(buf, XLSX);
    assert.deepEqual(res.errors, []);
    assert.equal(res.questions.length, importer.SAMPLE_ROWS.length);
  });

  it('空表格与缺列表头给出可读错误', () => {
    assert.deepEqual(importer.parseRows([]).errors, ['表格为空']);
    const res = importer.parseRows([['题型', '正确答案'], ['选择题', 'A']]);
    assert.equal(res.questions.length, 0);
    assert.match(res.errors[0], /表头缺少/);
  });
});
