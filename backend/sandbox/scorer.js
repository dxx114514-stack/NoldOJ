class Scorer {
  constructor(script) {
    this.script = script || '';
    this.vars = {};
    this.pos = 0;
    this.depth = 0;          // 嵌套深度计数器，防栈溢出
    this.MAX_DEPTH = 100;
  }

  getLineCol(pos) {
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < this.script.length; i++) {
      if (this.script[i] === '\n') { line++; col = 1; } else { col++; }
    }
    return { line, col };
  }

  err(msg) {
    const { line, col } = this.getLineCol(this.pos);
    return new Error(`${msg} at line ${line}, col ${col}`);
  }

  run(context) {
    this.vars = {};
    for (const [k, v] of Object.entries(context)) this.vars[k] = v;
    this.vars.AC = 1; this.vars.WA = 2; this.vars.TLE = 3; this.vars.MLE = 4; this.vars.UNAC = 2;
    this.pos = 0;
    try { this.parseBlock(); } catch (e) {
      return { total_score: 0, final_status: 'system_error', final_time: 0, final_memory: 0, error: e.message };
    }
    return {
      total_score: this.vars['@total_score'] || 0,
      final_status: this.statusToString(this.vars['@final_status'] || 2),
      final_time: this.vars['@final_time'] || 0,
      final_memory: this.vars['@final_memory'] || 0
    };
  }

  statusToString(val) {
    if (val === 1) return 'accepted';
    if (val === 2) return 'wrong_answer';
    if (val === 3) return 'time_limit_exceeded';
    if (val === 4) return 'memory_limit_exceeded';
    return 'wrong_answer';
  }

  skipWs() { while (this.pos < this.script.length && /[\s\r\n\t]/.test(this.script[this.pos])) this.pos++; }
  peek() { this.skipWs(); return this.script.slice(this.pos); }

  match(kw) {
    this.skipWs();
    if (!this.script.startsWith(kw, this.pos)) return false;
    const a = this.script[this.pos + kw.length];
    return !(a && /[a-zA-Z0-9_]/.test(a));
  }

  eat(kw) {
    this.skipWs();
    if (this.script.startsWith(kw, this.pos)) { this.pos += kw.length; return true; }
    return false;
  }

  expect(s) { if (!this.eat(s)) throw this.err(`Expected "${s}"`); }

  // ===== Block / Statement =====
  parseBlock() {
    while (this.pos < this.script.length) {
      this.skipWs();
      if (this.pos >= this.script.length) break;
      if (this.match('fi') || this.match('else') || this.peek() === '') break;
      this.parseStmt();
    }
  }

  parseStmt() {
    this.skipWs();
    if (this.match('if')) this.parseIf();
    else { this.parseAssign(); this.expect(';'); }
  }

  parseAssign() {
    const name = this.parseVar();
    this.expect('=');
    this.vars[name] = this.parseFullExpr();
  }

  parseIf() {
    if (this.depth >= this.MAX_DEPTH) {
      throw this.err(`Nested if/else exceeds max depth of ${this.MAX_DEPTH}`);
    }
    this.depth++;
    try {
      this.eat('if');
      const cond = this.parseCondExpr();
      this.expect(';'); this.expect('then');
      if (cond) {
        this.parseBlock(); this.skipWs();
        if (this.match('else')) { this.eat('else'); this.skipTilFi(0); }
      } else {
        this.skipTilFi(0); this.skipWs();
        if (this.match('else')) { this.eat('else'); this.parseBlock(); }
      }
      this.expect('fi');
    } finally {
      this.depth--;
    }
  }

  skipTilFi(depth) {
    while (this.pos < this.script.length) {
      this.skipWs();
      if (this.pos >= this.script.length) break;
      if (this.match('if')) { depth++; this.eat('if'); }
      else if (this.match('fi')) { if (depth === 0) break; depth--; this.eat('fi'); }
      else if (this.match('else') && depth === 0) break;
      else this.pos++;
    }
  }

  // ===== CONDITION: logical or/and/not connecting comparisons =====
  parseCondExpr() { return this.cOr(); }
  cOr() { let l = this.cAnd(); while (this.match('or')) { this.eat('or'); const r = this.cAnd(); l = (l || r) ? 1 : 0; } return l; }
  cAnd() { let l = this.cNot(); while (this.match('and')) { this.eat('and'); const r = this.cNot(); l = (l && r) ? 1 : 0; } return l; }
  cNot() {
    if (this.match('not')) { this.eat('not'); return this.cNot() ? 0 : 1; }
    if (this.eat('(')) { const v = this.parseCondExpr(); this.expect(')'); return v; }
    return this.cCmp();
  }

  cCmp() {
    let l = this.parseArith();
    for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
      if (this.eat(op)) {
        const r = this.parseArith();
        if (op === '==') return l === r ? 1 : 0;
        if (op === '!=') return l !== r ? 1 : 0;
        if (op === '>=') return l >= r ? 1 : 0;
        if (op === '<=') return l <= r ? 1 : 0;
        if (op === '>') return l > r ? 1 : 0;
        if (op === '<') return l < r ? 1 : 0;
      }
    }
    return l;
  }

  // ===== FULL VALUE expr (for assignments): bitwise or/xor/and + arithmetic =====
  parseFullExpr() { return this.fBOr(); }
  fBOr() { let l = this.fBXor(); while (this.match('or')) { this.eat('or'); l = l | this.fBXor(); } return l; }
  fBXor() { let l = this.fBAnd(); while (this.match('xor')) { this.eat('xor'); l = l ^ this.fBAnd(); } return l; }
  fBAnd() { let l = this.parseArith(); while (this.match('and')) { this.eat('and'); l = l & this.parseArith(); } return l; }

  // ===== ARITHMETIC expr (no bitwise or/and — used by cCmp operands) =====
  parseArith() { return this.aAdd(); }
  aAdd() {
    let l = this.aMul();
    while (true) { this.skipWs(); if (this.eat('+')) l += this.aMul(); else if (this.eat('-')) l -= this.aMul(); else break; }
    return l;
  }
  aMul() {
    let l = this.aUnary();
    while (true) {
      this.skipWs();
      if (this.eat('*')) l *= this.aUnary();
      else if (this.eat('/')) { const r = this.aUnary(); if (r === 0) throw this.err('Division by zero'); l = Math.trunc(l / r); }
      else if (this.eat('%')) { const r = this.aUnary(); if (r === 0) throw this.err('Modulo by zero'); l = l % r; }
      else break;
    }
    return l;
  }
  aUnary() { this.skipWs(); if (this.eat('-')) return -this.aAtom(); if (this.eat('+')) return this.aAtom(); return this.aAtom(); }
  aAtom() {
    this.skipWs();
    if (this.eat('(')) { const v = this.parseCondExpr(); this.expect(')'); return v; }
    if (this.script[this.pos] === '@') return this.vars[this.parseVar()] || 0;
    const KW = { AC: 1, WA: 2, TLE: 3, MLE: 4, UNAC: 2 };
    for (const [k, v] of Object.entries(KW)) { if (this.match(k)) { this.eat(k); return v; } }
    return this.pFuncOrNum();
  }

  pFuncOrNum() {
    this.skipWs();
    if (this.match('min')) { this.eat('min'); this.expect('('); const a = this.parseArith(); this.expect(','); const b = this.parseArith(); this.expect(')'); return Math.min(a, b); }
    if (this.match('max')) { this.eat('max'); this.expect('('); const a = this.parseArith(); this.expect(','); const b = this.parseArith(); this.expect(')'); return Math.max(a, b); }
    if (this.match('abs')) { this.eat('abs'); this.expect('('); const a = this.parseArith(); this.expect(')'); return Math.abs(a); }
    if (this.script[this.pos] === '@') return this.vars[this.parseVar()] || 0;
    return this.pNum();
  }

  parseVar() {
    this.skipWs();
    if (this.script[this.pos] !== '@') throw this.err('Expected variable (@name)');
    let n = '@'; this.pos++;
    while (this.pos < this.script.length && /[a-zA-Z0-9_]/.test(this.script[this.pos])) { n += this.script[this.pos]; this.pos++; }
    return n;
  }

  pNum() {
    this.skipWs();
    let s = '';
    while (this.pos < this.script.length && /[0-9]/.test(this.script[this.pos])) { s += this.script[this.pos]; this.pos++; }
    if (!s) throw this.err('Expected number');
    return parseInt(s, 10);
  }
}

function runScoringScript(script, context) {
  if (!script || !script.trim()) return null;
  return new Scorer(script).run(context);
}

module.exports = { Scorer, runScoringScript };
