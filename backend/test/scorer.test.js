const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runScoringScript } = require('../sandbox/scorer');

describe('Scorer', () => {
  describe('basic assignment', () => {
    it('should assign variables', () => {
      const result = runScoringScript('@total_score = 10; @final_status = AC;', {});
      assert.equal(result.total_score, 10);
      assert.equal(result.final_status, 'accepted');
    });

    it('should default missing vars to 0', () => {
      const result = runScoringScript('@total_score = @nonexistent;', {});
      assert.equal(result.total_score, 0);
    });
  });

  describe('arithmetic', () => {
    it('should do addition', () => {
      const result = runScoringScript('@total_score = 10 + 20;', {});
      assert.equal(result.total_score, 30);
    });

    it('should do subtraction', () => {
      const result = runScoringScript('@total_score = 50 - 20;', {});
      assert.equal(result.total_score, 30);
    });

    it('should do multiplication', () => {
      const result = runScoringScript('@total_score = 5 * 6;', {});
      assert.equal(result.total_score, 30);
    });

    it('should do integer division', () => {
      const result = runScoringScript('@total_score = 7 / 2;', {});
      assert.equal(result.total_score, 3);
    });

    it('should do modulo', () => {
      const result = runScoringScript('@total_score = 7 % 3;', {});
      assert.equal(result.total_score, 1);
    });

    it('should throw on division by zero', () => {
      const result = runScoringScript('@total_score = 10 / 0;', {});
      assert.equal(result.final_status, 'system_error');
      assert.ok(result.error.includes('Division by zero'));
    });

    it('should throw on modulo by zero', () => {
      const result = runScoringScript('@total_score = 10 % 0;', {});
      assert.equal(result.final_status, 'system_error');
      assert.ok(result.error.includes('Modulo by zero'));
    });

    it('should handle operator precedence', () => {
      const result = runScoringScript('@total_score = 2 + 3 * 4;', {});
      assert.equal(result.total_score, 14);
    });

    it('should handle unary minus', () => {
      const result = runScoringScript('@total_score = -5;', {});
      assert.equal(result.total_score, -5);
    });

    it('should handle parenthesized expressions', () => {
      const result = runScoringScript('@total_score = (2 + 3) * 4;', {});
      assert.equal(result.total_score, 20);
    });
  });

  describe('comparison', () => {
    it('should compare equal', () => {
      const result = runScoringScript('if (5==5); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should compare not equal', () => {
      const result = runScoringScript('if (5!=3); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should compare greater than', () => {
      const result = runScoringScript('if (5>3); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should compare less than', () => {
      const result = runScoringScript('if (3<5); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should compare greater or equal', () => {
      const result = runScoringScript('if (5>=5); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should compare less or equal', () => {
      const result = runScoringScript('if (5<=5); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });
  });

  describe('logic operators', () => {
    it('should handle and', () => {
      const result = runScoringScript('if (1==1) and (2==2); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should handle or', () => {
      const result = runScoringScript('if (1==2) or (2==2); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should handle not', () => {
      const result = runScoringScript('if not (1==2); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should handle parentheses in conditions', () => {
      const result = runScoringScript('if ((1==1) and (2==2)) or (3==1); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should handle nested not', () => {
      const result = runScoringScript('if not not (1==1); then @total_score = 10; fi', {});
      assert.equal(result.total_score, 10);
    });
  });

  describe('if/else', () => {
    it('should execute then branch when true', () => {
      const result = runScoringScript('if (1==1); then @total_score = 10; else @total_score = 0; fi', {});
      assert.equal(result.total_score, 10);
    });

    it('should execute else branch when false', () => {
      const result = runScoringScript('if (1==2); then @total_score = 10; else @total_score = 0; fi', {});
      assert.equal(result.total_score, 0);
    });

    it('should handle nested if', () => {
      const result = runScoringScript(`
        if (1==1); then
          if (2==2); then
            @total_score = 10;
          else
            @total_score = 0;
          fi
        else
          @total_score = 0;
        fi
      `, {});
      assert.equal(result.total_score, 10);
    });
  });

  describe('builtin functions', () => {
    it('min should return smaller value', () => {
      const result = runScoringScript('@total_score = min(10, 20);', {});
      assert.equal(result.total_score, 10);
    });

    it('max should return larger value', () => {
      const result = runScoringScript('@total_score = max(10, 20);', {});
      assert.equal(result.total_score, 20);
    });

    it('abs should return absolute value', () => {
      const result = runScoringScript('@total_score = abs(-5);', {});
      assert.equal(result.total_score, 5);
    });

    it('abs should handle positive value', () => {
      const result = runScoringScript('@total_score = abs(5);', {});
      assert.equal(result.total_score, 5);
    });
  });

  describe('bitwise operations', () => {
    it('should do bitwise or', () => {
      const result = runScoringScript('@total_score = 5 or 3;', {});
      assert.equal(result.total_score, 7);
    });

    it('should do bitwise and', () => {
      const result = runScoringScript('@total_score = 5 and 3;', {});
      assert.equal(result.total_score, 1);
    });

    it('should do bitwise xor', () => {
      const result = runScoringScript('@total_score = 5 xor 3;', {});
      assert.equal(result.total_score, 6);
    });
  });

  describe('empty/whitespace scripts', () => {
    it('should return null for empty script', () => {
      const result = runScoringScript('', {});
      assert.equal(result, null);
    });

    it('should return null for whitespace only', () => {
      const result = runScoringScript('   \n  \t  ', {});
      assert.equal(result, null);
    });
  });

  describe('error handling', () => {
    it('should return system_error on syntax error', () => {
      const result = runScoringScript('if ; then', {});
      assert.equal(result.final_status, 'system_error');
      assert.ok(result.error);
    });

    it('should report line and column in errors', () => {
      const result = runScoringScript('@total = 10 / 0;', {});
      assert.ok(result.error.includes('line'));
      assert.ok(result.error.includes('col'));
    });
  });

  describe('real-world scoring script', () => {
    it('should score correctly with subtask dependencies', () => {
      const script = `
        if (@status1==AC) and (@status2==AC); then
          @total_score = 30;
          @final_status = AC;
          @final_time = max(@time1, @time2);
          @final_memory = max(@memory1, @memory2);
        else
          @total_score = 0;
          @final_status = UNAC;
        fi
      `;
      const context = {
        '@status1': 1, '@status2': 1,
        '@time1': 100, '@time2': 200,
        '@memory1': 1024, '@memory2': 2048
      };
      const result = runScoringScript(script, context);
      assert.equal(result.total_score, 30);
      assert.equal(result.final_status, 'accepted');
      assert.equal(result.final_time, 200);
      assert.equal(result.final_memory, 2048);
    });

    it('should handle partial pass', () => {
      const script = `
        @total_score = @score1;
        if (@status1==AC); then
          @final_status = AC;
        else
          @total_score = 0;
          @final_status = UNAC;
        fi
      `;
      const context = { '@status1': 2, '@score1': 10 };
      const result = runScoringScript(script, context);
      assert.equal(result.total_score, 0);
      assert.equal(result.final_status, 'wrong_answer');
    });
  });
});
