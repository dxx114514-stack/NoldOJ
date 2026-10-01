const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'log/**', 'public/**', 'storage/**', 'tmp/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 代码库中大量 `try { ... } catch {}` 用于"尽力而为"的清理/降级路径，
      // 属于有意为之；空的 if/while/函数块仍然视为错误。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
