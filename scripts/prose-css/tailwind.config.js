// frontend/css/prose.css 的构建配置，用法见 input.css 头部注释。
// content.raw 必须与页面上实际出现的 prose 相关类名保持一致，新增变体需同步此处。
module.exports = {
  darkMode: 'class',
  content: [
    { raw: 'prose prose-invert prose-sm prose-gray dark:prose-invert not-prose' },
  ],
  theme: { extend: {} },
  plugins: [require('@tailwindcss/typography')],
}
