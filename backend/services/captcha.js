const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

// 自绘 SVG 验证码：替代已停止维护的 svg-captcha（1.4.0，2019 年后无更新）。
// R10 方案 A: 字符不再用 <text> 元素渲染（明文答案在 DOM 中可复制/被脚本 matchAll 提取），
//             改为启动时用 opentype.js 将捆绑字体的字形转换为 <path> 轮廓数据，
//             答案字符串永不进入 SVG，DOM/OCR 提取失效，浏览器也无法选中复制。
// D-M2: 所有随机数改用 crypto.randomInt（CSPRNG，消除 Math.random 可预测性）；
//       叠加 feTurbulence + feDisplacementMap 波形扭曲滤镜，破坏对 SVG DOM/位图
//       的自动字符提取（字符轮廓被位移，简单 OCR/模板匹配显著失效）。

// R10 方案 A 字体: DejaVu Sans Bold (Bitstream Vera / DejaVu license, 可自由嵌入分发)
const FONT_FILE = path.join(__dirname, '..', 'assets', 'fonts', 'dejavu-sans-latin-700-normal.woff');

const sessions = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
// 防止高并发请求无限增长导致内存耗尽: 超出后淘汰最旧的验证码
const MAX_SESSIONS = 10000;

const CHAR_PRESET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WIDTH = 120;
const HEIGHT = 44;
const FONT_SIZE = 24;
const GLYPH_STEP = 26;
const GLYPH_X0 = 18;

// 将字体字形解析为 SVG path data（M/L/C/Z 命令，坐标已缩放到像素、SVG 坐标系：
// 基线在 y=0，字形主体向上延伸为负 y）。仅在服务启动时执行一次；
// 失败时抛错，避免静默降级回可提取的 <text>。
function buildGlyphPaths() {
  const buf = fs.readFileSync(FONT_FILE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const font = opentype.parse(ab);
  const map = {};
  for (const ch of CHAR_PRESET) {
    const pathData = font.getPath(ch, 0, 0, FONT_SIZE).toPathData();
    if (!pathData) throw new Error(`captcha: 无法为 ${ch} 生成轮廓`);
    map[ch] = pathData;
  }
  return map;
}

const GLYPH_PATHS = buildGlyphPaths();

function randInt(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || b < a) return a;
  // crypto.randomInt([max]) / crypto.randomInt(min, max) 返回 [min, max) 内均匀整数
  return crypto.randomInt(a, b + 1);
}

function randColor() {
  const r = randInt(40, 180);
  const g = randInt(40, 180);
  const b = randInt(40, 180);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function pickText() {
  let text = '';
  for (let i = 0; i < 4; i++) {
    text += CHAR_PRESET[randInt(0, CHAR_PRESET.length - 1)];
  }
  return text;
}

// 字形路径以基线为 y=0（向上为负）。转为 SVG 坐标时平移到基线位置并旋转。
function generateSvg(text) {
  const chars = text.split('');
  const glyphs = chars.map((ch, i) => {
    const x = GLYPH_X0 + i * GLYPH_STEP;
    const y = randInt(26, 34);
    const rotate = randInt(-20, 20);
    const color = randColor();
    return `<path d="${GLYPH_PATHS[ch]}" transform="translate(${x} ${y}) rotate(${rotate})" fill="${color}"/>`;
  }).join('');

  // 噪线 + 随机贝塞尔干扰曲线
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const x1 = randInt(0, WIDTH * 0.3);
    const y1 = randInt(0, HEIGHT);
    const x2 = randInt(WIDTH * 0.7, WIDTH);
    const y2 = randInt(0, HEIGHT);
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${randColor()}" stroke-width="1" opacity="0.6"/>`);
  }
  for (let i = 0; i < 2; i++) {
    const mx = randInt(0, WIDTH);
    const my = randInt(0, HEIGHT);
    const cx1 = randInt(0, WIDTH);
    const cy1 = randInt(0, HEIGHT);
    const cx2 = randInt(0, WIDTH);
    const cy2 = randInt(0, HEIGHT);
    lines.push(`<path d="M${mx} ${my} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${randInt(0, WIDTH)} ${randInt(0, HEIGHT)}" stroke="${randColor()}" stroke-width="1.2" fill="none" opacity="0.5"/>`);
  }

  // 噪点
  const dots = [];
  for (let i = 0; i < 30; i++) {
    dots.push(`<circle cx="${randInt(0, WIDTH)}" cy="${randInt(0, HEIGHT)}" r="${randInt(1, 2)}" fill="${randColor()}" opacity="0.5"/>`);
  }

  // D-M2: 波形扭曲滤镜 —— 对整组图形施加随机 displacement，
  // 字符像素被非线性平移，自动提取/OCR 的字符边界被破坏。
  const turbSeed = randInt(0, 1000);
  const scale = randInt(4, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs><filter id="wob" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.08 0.12" numOctaves="2" seed="${turbSeed}" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter></defs><rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>${dots.join('')}${lines.join('')}<g filter="url(#wob)">${glyphs}</g></svg>`;
}

// WINOJ_CAPTCHA_DEBUG=1 时响应携带 code —— 仅供黑盒集成测试获取答案。
// 生产环境不要设置该变量。
function generateCaptcha() {
  const text = pickText();
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + CAPTCHA_TTL;
  sessions.set(id, { text: text.toLowerCase(), expiresAt });
  if (sessions.size > MAX_SESSIONS) {
    // 淘汰最旧的验证码，防止 OOM
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
  cleanup();
  const out = { id, svg: generateSvg(text) };
  if (process.env.WINOJ_CAPTCHA_DEBUG === '1') out.code = text;
  return out;
}

function verifyCaptcha(id, text) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  if (Date.now() > session.expiresAt) return false;
  if (!text) return false;
  return session.text === String(text).toLowerCase().replace(/\s+/g, '');
}

function cleanup() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}

// unref: 清理定时器不阻止进程退出（node --test 可正常结束；生产不受影响）
const cleanupTimer = setInterval(cleanup, 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { generateCaptcha, verifyCaptcha };