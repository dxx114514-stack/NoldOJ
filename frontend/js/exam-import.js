/**
 * 试卷 Excel 导入（前端）
 *
 * 数据流：文件 -> SheetJS 读成二维数组 -> parseRows() 解析成 exam_questions 形状的题目
 * 解析是纯函数，浏览器与 Node（测试）共用，因此用 UMD 包一层。
 *
 * 模板列（首行表头可省略，省略时按固定顺序读取）：
 *   题型 | 题目内容 | 选项A | 选项B | 选项C | 选项D | 正确答案 | 分值 | 主观题 | AI评分提示词
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NoldExamImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADER = ['题型', '题目内容', '选项A', '选项B', '选项C', '选项D', '正确答案', '分值', '主观题', 'AI评分提示词'];

  const SAMPLE_ROWS = [
    ['选择题', '下列哪个算法的平均时间复杂度是 $O(n \\log n)$？', '冒泡排序', '快速排序', '选择排序', '插入排序', 'B', '10', '', ''],
    ['判断题', '堆排序在最坏情况下的时间复杂度是 $O(n \\log n)$。', '', '', '', '', '对', '5', '', ''],
    ['填空题', '归并排序的空间复杂度为 $O(\\_\\_)$。', '', '', '', '', 'n', '5', '是', '允许写成 O(n) 或 n'],
    ['大题', '请描述 Dijkstra 算法的基本思想，并分析其时间复杂度。', '', '', '', '', '', '20', '是', '按要点给分：正确性、堆优化、复杂度']
  ];

  const TYPE_ALIAS = {
    choice: 'choice', '选择题': 'choice', '选择': 'choice', '单选': 'choice', '单选题': 'choice', 'select': 'choice',
    true_false: 'true_false', '判断题': 'true_false', '判断': 'true_false', '对错题': 'true_false', '是非题': 'true_false', 'tf': 'true_false',
    fill_blank: 'fill_blank', '填空题': 'fill_blank', '填空': 'fill_blank', 'blank': 'fill_blank',
    long_answer: 'long_answer', '大题': 'long_answer', '主观题': 'long_answer', '简答题': 'long_answer', '简答': 'long_answer', '论述题': 'long_answer', 'essay': 'long_answer'
  };

  const TRUE_WORDS = ['true', 't', '1', 'yes', 'y', 'v', '对', '正确', '是', '√', '✓'];
  const FALSE_WORDS = ['false', 'f', '0', 'no', 'n', 'x', '错', '错误', '否', '×', '✗'];

  const FIELD_ALIAS = {
    type: ['题型', 'type', '类型'],
    title: ['题目内容', '题目', '题面', '内容', 'title', 'content', 'question'],
    answer: ['正确答案', '答案', 'answer', 'correctanswer', 'key'],
    score: ['分值', '分数', '分', 'score', 'points'],
    subjective: ['主观题', '主观', '需人工评分', 'issubjective', 'subjective'],
    ai: ['ai评分提示词', 'ai提示词', '评分提示词', 'ai_grading_prompt', 'aiprompt', 'prompt']
  };

  function normalizeHead(v) {
    return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_\-()（）：:]/g, '');
  }

  function cell(row, i) {
    if (!row || i === undefined || i === null) return '';
    const v = row[i];
    return String(v == null ? '' : v).trim();
  }

  /** rows 下标 -> Excel 行号（含表头，表头占第 1 行） */
  function excelRow(index) {
    return index + 1;
  }

  /** 表头对应的选项字母：'' 表示无字母的单列多选项，undefined 表示不是选项列 */
  function optionHeadLetter(h) {
    if (h === '选项' || h === 'options' || h === 'option') return '';
    if (h.indexOf('选项') === 0) return h.slice(2).toUpperCase();
    if (/^option[a-h]$/.test(h)) return h.slice(6).toUpperCase();
    if (/^[a-h]$/.test(h)) return h.toUpperCase();
    return undefined;
  }

  /** 仅用于表头判定：裸字母（A/B/C…）也可能出现在数据里，不拿它当表头线索 */
  function isOptionHeadHint(h) {
    return h === '选项' || h === 'options' || h === 'option' || h.indexOf('选项') === 0;
  }

  /** 识别表头：返回 { hasHeader, map }，map.options 按标签字母排序，保证答案字母与选项下标一致 */
  function buildMap(rows, hasHeader) {
    const head = rows[0] || [];
    const map = { options: [] };

    if (!hasHeader) {
      map.type = 0;
      map.title = 1;
      map.options = [{ col: 2 }, { col: 3 }, { col: 4 }, { col: 5 }];
      map.answer = 6;
      map.score = 7;
      map.subjective = 8;
      map.ai = 9;
      return map;
    }

    const cells = head.map(normalizeHead);
    Object.keys(FIELD_ALIAS).forEach((field) => {
      for (let i = 0; i < cells.length; i++) {
        if (FIELD_ALIAS[field].indexOf(cells[i]) >= 0) { map[field] = i; break; }
      }
    });

    for (let i = 0; i < cells.length; i++) {
      const letter = optionHeadLetter(cells[i]);
      if (letter === undefined) continue;
      if (letter === '' || /^[A-H]$/.test(letter)) map.options.push({ col: i, letter: letter || null });
    }
    map.options.sort((a, b) => {
      if (a.letter && b.letter && a.letter !== b.letter) return a.letter < b.letter ? -1 : 1;
      return a.col - b.col;
    });

    return map;
  }

  function parseType(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return null;
    if (TYPE_ALIAS[s]) return TYPE_ALIAS[s];
    return TYPE_ALIAS[s.replace(/[\s_\-]/g, '')] || null;
  }

  function parseChoiceAnswer(raw) {
    const s = String(raw == null ? '' : raw).trim()
      .replace(/^[（(【\[\s.、:：]+/, '')
      .replace(/[）)】\]\s]+$/, '');
    if (!s) return { error: '正确答案为空' };
    const letters = s.toUpperCase().match(/[A-Z]/g) || [];
    if (letters.length === 0) return { error: '须为选项字母（A/B/C/D），当前「' + raw + '」' };
    if (letters.length > 1) return { error: '仅支持单选，检测到多个字母「' + letters.join('') + '」' };
    return { value: letters[0] };
  }

  function parseTrueFalse(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (TRUE_WORDS.indexOf(s) >= 0) return { value: 'true' };
    if (FALSE_WORDS.indexOf(s) >= 0) return { value: 'false' };
    return { error: '须为 对/错、true/false、1/0，当前「' + raw + '」' };
  }

  function parseSubjective(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    return s && TRUE_WORDS.indexOf(s) >= 0 ? 1 : 0;
  }

  function splitOptions(values) {
    // 单个「选项」列里用换行 / | / ；分隔多个选项时拆开
    if (values.length === 1 && /[\n|；;]/.test(values[0])) {
      return values[0].split(/[\n|；;]+/).map((s) => s.trim()).filter(Boolean);
    }
    return values.map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 二维数组 -> { questions, errors }
   * rows: SheetJS sheet_to_json(sheet, { header: 1 }) 的结果
   * questions 字段与后端 POST/PUT /exams 的 questions 元素一一对应
   */
  function parseRows(rows) {
    const questions = [];
    const errors = [];
    if (!Array.isArray(rows) || rows.length === 0) return { questions, errors: ['表格为空'] };

    const firstCells = (rows[0] || []).map(normalizeHead);
    // 表头判定：首行出现「题型」锚点、命中 ≥2 个列名别名，或出现选项列表头
    const matchedFields = Object.keys(FIELD_ALIAS)
      .filter((k) => firstCells.some((h) => FIELD_ALIAS[k].indexOf(h) >= 0));
    const hasAnchor = firstCells.some((h) => h === '题型' || h === 'type' || h === '类型');
    const hasHeader = hasAnchor || matchedFields.length >= 2 || firstCells.some(isOptionHeadHint);
    const map = buildMap(rows, hasHeader);

    if (hasHeader && (map.type === undefined || map.title === undefined)) {
      return { questions, errors: ['表头缺少「题型」或「题目内容」列'] };
    }
    if (hasHeader && map.answer === undefined) {
      errors.push('提示：表头缺少「正确答案」列，选择/判断/填空题会因缺答案被跳过');
    }

    for (let r = hasHeader ? 1 : 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const line = excelRow(r);
      const no = '第 ' + line + ' 行：';

      if (row.every((c) => String(c == null ? '' : c).trim() === '')) continue;
      if (hasHeader && normalizeHead(row[map.type]) === '题型') continue;

      const type = parseType(cell(row, map.type));
      if (!type) { errors.push(no + '无法识别题型「' + cell(row, map.type) + '」（支持 选择题/判断题/填空题/大题）'); continue; }

      const title = cell(row, map.title);
      if (!title) { errors.push(no + '题目内容为空'); continue; }

      let options = [];
      if (type === 'choice') {
        if (map.options.length === 0) { errors.push(no + '表头中没有找到选项列（选项A/选项B…）'); continue; }
        options = splitOptions(map.options.map((o) => cell(row, o.col)));
        if (options.length < 2) { errors.push(no + '选择题至少需要 2 个非空选项'); continue; }
      }

      const rawAnswer = cell(row, map.answer);
      let correct = '';
      if (type === 'choice') {
        let parsed = parseChoiceAnswer(rawAnswer);
        if (parsed.error) {
          // 允许直接写选项文本，按文本匹配回字母
          const byText = options.findIndex((o) => o.toLowerCase() === rawAnswer.trim().toLowerCase());
          if (byText >= 0) parsed = { value: String.fromCharCode(65 + byText) };
        }
        if (parsed.error) { errors.push(no + '选择题' + parsed.error); continue; }
        correct = parsed.value;
        if (correct.charCodeAt(0) - 65 >= options.length) {
          errors.push(no + '答案「' + correct + '」超出选项范围（只有 ' + options.length + ' 个选项）'); continue;
        }
      } else if (type === 'true_false') {
        const parsed = parseTrueFalse(rawAnswer);
        if (parsed.error) { errors.push(no + '判断题' + parsed.error); continue; }
        correct = parsed.value;
      } else {
        correct = rawAnswer;
        if (type === 'fill_blank' && !parseSubjective(cell(row, map.subjective)) && !correct) {
          errors.push(no + '填空题正确答案为空'); continue;
        }
      }

      let score = 5;
      const rawScore = cell(row, map.score);
      if (rawScore !== '') {
        const n = Number(rawScore);
        if (!isFinite(n) || n < 0) { errors.push(no + '分值必须是非负数字，当前「' + rawScore + '」'); continue; }
        score = n;
      }

      let subjective = parseSubjective(cell(row, map.subjective));
      if (type === 'long_answer') subjective = 1;

      questions.push({
        question_type: type,
        title: title,
        options: options,
        correct_answer: correct,
        score: score,
        is_subjective: subjective,
        ai_grading_prompt: cell(row, map.ai)
      });
    }

    return { questions, errors };
  }

  function resolveLib(lib) {
    if (lib) return lib;
    if (typeof XLSX !== 'undefined') return XLSX;
    if (typeof globalThis !== 'undefined' && globalThis.XLSX) return globalThis.XLSX;
    return null;
  }

  function readRows(buf, lib) {
    const X = resolveLib(lib);
    if (!X) throw new Error('Excel 解析库未加载（xlsx.full.min.js）');
    const wb = X.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('工作簿中没有可读的工作表');
    return X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }

  function importBuffer(buf, lib) {
    return parseRows(readRows(buf, lib));
  }

  function importFile(file, lib) {
    if (!file) return Promise.resolve({ questions: [], errors: ['未选择文件'] });
    return Promise.resolve(file.arrayBuffer()).then((buf) => importBuffer(buf, lib));
  }

  /** 构造模板工作簿（单表：表头 + 示例行），downloadTemplate 与站内示例文件共用 */
  function buildWorkbook(lib) {
    const X = resolveLib(lib);
    if (!X) throw new Error('Excel 解析库未加载（xlsx.full.min.js）');
    const ws = X.utils.aoa_to_sheet([HEADER].concat(SAMPLE_ROWS));
    ws['!cols'] = [
      { wch: 8 }, { wch: 46 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
      { wch: 10 }, { wch: 6 }, { wch: 8 }, { wch: 26 }
    ];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, '试卷题目');
    return wb;
  }

  /** 生成并下载模板，返回文件名 */
  function downloadTemplate(lib, filename) {
    const X = resolveLib(lib);
    if (!X) throw new Error('Excel 解析库未加载（xlsx.full.min.js）');
    const name = filename || '试卷题目模板.xlsx';
    X.writeFile(buildWorkbook(X), name);
    return name;
  }

  return {
    HEADER: HEADER,
    SAMPLE_ROWS: SAMPLE_ROWS,
    parseRows: parseRows,
    readRows: readRows,
    importBuffer: importBuffer,
    importFile: importFile,
    buildWorkbook: buildWorkbook,
    downloadTemplate: downloadTemplate
  };
});
