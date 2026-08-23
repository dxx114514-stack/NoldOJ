const config = require('../config/config');

// 通用 AI 客户端：面向 OpenAI 兼容 chat 接口（Ollama /api/chat）。
// aiChat / aiChatJSON 接受可选 cfg 参数，实现每个 AI 功能独立的 URL/模型/密钥配置。
// cfg 格式: { enabled, url, model, key } —— 缺省回退 config.security。

function isFeatureEnabled(cfg) {
  const c = cfg || config.security;
  return c.enabled === true;
}

// 发一次非流式 chat 请求，返回模型输出文本；失败/超时抛错。
async function aiChat(systemPrompt, userMessage, opts = {}) {
  const cfg = opts.cfg || config.security;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key) headers['Authorization'] = `Bearer ${cfg.key}`;
  const timeoutMs = opts.timeoutMs || 60000;
  const response = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: false,
      options: { temperature: opts.temperature ?? 0.2, num_predict: opts.numPredict || 4096 }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`AI 服务返回 HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.message?.content || '';
}

// 要求模型输出单一 JSON 对象，提取并解析第一个 {...} 块。
async function aiChatJSON(systemPrompt, userMessage, opts = {}) {
  const content = await aiChat(systemPrompt, userMessage, opts);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('无法从 AI 响应中解析 JSON');
  }
  return JSON.parse(match[0]);
}

module.exports = { aiEnabled: isFeatureEnabled, aiChat, aiChatJSON };
