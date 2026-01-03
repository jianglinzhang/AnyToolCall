// tool-proxy.js
// Version: 2.0.0 (AnyToolCall Edition)
const express = require('express');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const url = require('url');

const app = express();
// 增大 body limit 以支持上传图片等大 payload
app.use(express.json({ limit: '50mb' }));

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_ENABLED = process.env.LOG_ENABLED === 'true'; // 默认关闭日志保存
const ALLOW_LOCAL_NET = process.env.ALLOW_LOCAL_NET === 'true'; // 默认禁止转发到内网

if (LOG_ENABLED && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ============ 安全检查 (SSRF 防护) ============
async function validateUpstream(upstreamUrl) {
  if (!upstreamUrl) return { valid: false, error: 'Missing upstream URL' };
  
  try {
    const parsed = new url.URL(upstreamUrl);
    
    // 1. 协议检查
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Invalid protocol (http/https only)' };
    }

    // 如果允许内网，直接通过
    if (ALLOW_LOCAL_NET) return { valid: true };

    // 2. 主机名检查 (防止 localhost)
    const hostname = parsed.hostname;
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
      return { valid: false, error: 'Localhost access denied (Set ALLOW_LOCAL_NET=true to enable)' };
    }

    // 3. DNS 解析检查私有 IP
    // 注意: 这只是基础防护，生产环境建议配合防火墙
    try {
      const { address } = await dns.lookup(hostname);
      const parts = address.split('.').map(Number);
      
      // 简单的 IPv4 私有地址检查
      if (parts.length === 4) {
        if (parts[0] === 10) return { valid: false, error: 'Private IP range (10.x.x.x) denied' };
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return { valid: false, error: 'Private IP range (172.16-31.x.x) denied' };
        if (parts[0] === 192 && parts[1] === 168) return { valid: false, error: 'Private IP range (192.168.x.x) denied' };
        if (parts[0] === 127) return { valid: false, error: 'Loopback IP denied' };
      }
    } catch (e) {
      // DNS 解析失败通常意味着无法连接，暂且放行让 fetch 报错，或者拦截
      // 这里选择放行，因为可能是内部 DNS
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// ============ 日志系统 ============
class RequestLogger {
  constructor() {
    this.enabled = LOG_ENABLED;
    this.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = Date.now();
    this.data = {
      requestId: this.requestId,
      timestamp: new Date().toISOString(),
      phases: []
    };
  }

  log(phase, content) {
    if (!this.enabled) return;
    const entry = { phase, time: Date.now() - this.startTime, content };
    this.data.phases.push(entry);
    
    // 控制台仅输出简略信息
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    console.log(`[${this.requestId}] ${phase}: ${str.slice(0, 150)}${str.length > 150 ? '...' : ''}`);
  }

  save() {
    if (!this.enabled) return;
    const filename = path.join(LOG_DIR, `${this.requestId}.json`);
    fs.writeFileSync(filename, JSON.stringify(this.data, null, 2), 'utf-8');
    console.log(`[${this.requestId}] 📁 Log saved: ${filename}`);
  }
}

// ============ 定界符系统 ============
const DELIMITER_SETS = [
  { open: '༒', close: '༒', mid: '࿇' },
  { open: '꧁', close: '꧂', mid: '࿔' },
  { open: '᎒', close: '᎒', mid: '᎓' },
  { open: 'ꆈ', close: 'ꆈ', mid: 'ꊰ' },
  { open: '꩜', close: '꩜', mid: '꩟' },
  { open: 'ꓸ', close: 'ꓸ', mid: 'ꓹ' },
];

const SUFFIX_POOL = [
  '龘', '靐', '齉', '麤', '爨', '驫', '鱻', '羴', '犇', '骉',
  '飝', '厵', '靇', '飍', '馫', '灥', '厽', '叒', '叕', '芔',
];

class ToolCallDelimiter {
  constructor() {
    this.markers = this.generateMarkers();
    console.log('🔧 AnyToolCall Delimiters initialized:\n' + this.describe());
  }

  generateMarkers() {
    const set = DELIMITER_SETS[Math.floor(Math.random() * DELIMITER_SETS.length)];
    const suffix1 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
    const suffix2 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
    const { open, close, mid } = set;
    
    return {
      TC_START: `${open}${suffix1}ᐅ`,
      TC_END: `ᐊ${suffix1}${close}`,
      NAME_START: `${mid}▸`,
      NAME_END: `◂${mid}`,
      ARGS_START: `${mid}▹`,
      ARGS_END: `◃${mid}`,
      RESULT_START: `${open}${suffix2}⟫`,
      RESULT_END: `⟪${suffix2}${close}`,
    };
  }

  describe() {
    return Object.entries(this.markers)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n');
  }

  getSystemPrompt(tools) {
    const m = this.markers;
    return `
## Tool Calling (AnyToolCall Protocol)

You have access to the following tools:
${tools.map(t => `- **${t.function.name}**: ${t.function.description || 'No description'}
  Parameters: ${JSON.stringify(t.function.parameters)}`).join('\n')}

### How to call tools

When you need to call a tool, use this EXACT format at the END of your response:

${m.TC_START}
${m.NAME_START}function_name${m.NAME_END}
${m.ARGS_START}{"param": "value"}${m.ARGS_END}
${m.TC_END}

### Example

I'll search for that information:

${m.TC_START}
${m.NAME_START}web_search${m.NAME_END}
${m.ARGS_START}{"query": "example", "limit": 5}${m.ARGS_END}
${m.TC_END}

### Rules

1. Tool calls MUST be at the END of your response
2. Copy the delimiters EXACTLY as shown above
3. Arguments must be valid JSON
4. One tool per block

### Tool Results

Results appear in ${m.RESULT_START}...${m.RESULT_END} blocks.
`;
  }

  parse(content, logger = null) {
    const m = this.markers;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    const regex = new RegExp(
      `${esc(m.TC_START)}\\s*` +
      `${esc(m.NAME_START)}([\\s\\S]*?)${esc(m.NAME_END)}\\s*` +
      `${esc(m.ARGS_START)}([\\s\\S]*?)${esc(m.ARGS_END)}\\s*` +
      `${esc(m.TC_END)}`,
      'g'
    );

    const toolCalls = [];
    let match;
    let idx = 0;
    
    while ((match = regex.exec(content)) !== null) {
      const name = match[1].trim();
      const argsStr = match[2].trim();
      
      try {
        JSON.parse(argsStr);
      } catch (e) {
        console.warn(`⚠️ Invalid JSON in tool call "${name}": ${argsStr}`);
        continue;
      }
      
      toolCalls.push({
        id: `call_${Date.now()}_${idx++}`,
        type: 'function',
        function: { name, arguments: argsStr }
      });
    }

    const cleanContent = content.replace(regex, '').trim();
    return { toolCalls, cleanContent };
  }
}

const delimiter = new ToolCallDelimiter();

// ============ 消息处理核心逻辑 ============

// 1. 合并相邻的相同 role 消息 (解决 Gemini 400 错误)
function mergeAdjacentMessages(messages, logger = null) {
  if (messages.length === 0) return messages;
  
  const merged = [];
  let current = { ...messages[0] };
  
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    
    if (msg.role === current.role) {
      const separator = '\n\n';
      current.content = (current.content || '') + separator + (msg.content || '');
    } else {
      merged.push(current);
      current = { ...msg };
    }
  }
  
  merged.push(current);
  return merged;
}

// 2. 转换请求 (支持有/无 tools 两种模式)
function transformRequest(request, logger = null, hasTools = true) {
  const m = delimiter.markers;
  let messages = [];

  const tools = request.tools || [];
  const toolSystemPrompt = hasTools && tools.length ? delimiter.getSystemPrompt(tools) : '';
  let hasSystem = false;

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      messages.push({
        role: 'system',
        content: msg.content + (toolSystemPrompt ? '\n\n' + toolSystemPrompt : '')
      });
      hasSystem = true;

    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      let content = msg.content || '';
      
      if (hasTools) {
        // 有 tools：转换为定界符格式
        for (const tc of msg.tool_calls) {
          content += `\n${m.TC_START}\n${m.NAME_START}${tc.function.name}${m.NAME_END}\n${m.ARGS_START}${tc.function.arguments}${m.ARGS_END}\n${m.TC_END}`;
        }
      } else {
        // 无 tools：清洗历史，转为纯文本
        const callSummary = msg.tool_calls.map(tc => tc.function.name).join(', ');
        content += `\n\n[Called tools: ${callSummary}]`;
      }
      
      messages.push({ role: 'assistant', content });

    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'unknown';
      const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      
      if (hasTools) {
        // 有 tools：用定界符包裹
        messages.push({
          role: 'user',
          content: `${m.RESULT_START}[${name}]\n${result}${m.RESULT_END}`
        });
      } else {
        // 无 tools：清洗历史，转为纯文本
        messages.push({
          role: 'user',
          content: `[Result from ${name}]:\n${result}`
        });
      }

    } else {
      messages.push({ ...msg });
    }
  }

  if (!hasSystem && toolSystemPrompt) {
    messages.unshift({ role: 'system', content: toolSystemPrompt });
  }

  // 合并相邻消息
  messages = mergeAdjacentMessages(messages, logger);

  const newRequest = { ...request, messages };
  delete newRequest.tools;
  delete newRequest.tool_choice;
  
  return newRequest;
}

// ============ 流式转换 ============
function createStreamTransformer(logger = null) {
  const startMarker = delimiter.markers.TC_START;
  let lineBuffer = '';
  let contentBuffer = '';
  let isBuffering = false;
  let pendingText = '';
  let streamEnded = false;

  function textChunk(text) {
    if (!text) return null;
    return `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    })}\n\n`;
  }

  function toolCallChunks(toolCalls) {
    return toolCalls.map((tc, i) => `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...tc }] }, finish_reason: null }]
    })}\n\n`).join('');
  }

  function finishChunk(reason) {
    return `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: {}, finish_reason: reason }]
    })}\n\n`;
  }

  function processLine(line, push) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed === 'data: [DONE]') {
      streamEnded = true;
      if (pendingText) {
        const tc = textChunk(pendingText);
        if (tc) push(tc);
        pendingText = '';
      }
      if (contentBuffer) {
        const { toolCalls, cleanContent } = delimiter.parse(contentBuffer, logger);
        if (cleanContent) {
          const tc = textChunk(cleanContent);
          if (tc) push(tc);
        }
        if (toolCalls.length > 0) {
          push(toolCallChunks(toolCalls));
          push(finishChunk('tool_calls'));
        } else {
          push(finishChunk('stop'));
        }
        contentBuffer = '';
      } else {
        push(finishChunk('stop'));
      }
      push('data: [DONE]\n\n');
      return;
    }

    if (!trimmed.startsWith('data: ')) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed.slice(6));
    } catch { return; }

    const content = parsed.choices?.[0]?.delta?.content;
    if (content === undefined || content === null) return;

    if (isBuffering) {
      contentBuffer += content;
    } else {
      const combined = pendingText + content;
      const startIdx = combined.indexOf(startMarker);
      if (startIdx !== -1) {
        const before = combined.slice(0, startIdx);
        if (before) {
          const tc = textChunk(before);
          if (tc) push(tc);
        }
        contentBuffer = combined.slice(startIdx);
        pendingText = '';
        isBuffering = true;
      } else {
        // 简单处理：如果 buffer 没满且没有标记，直接输出
        // 这里简化了 findPartialMatch 逻辑，直接输出以提高响应速度
        // 只有当末尾可能是标记的一部分时才 pending
        // 为安全起见，我们假设只要没有 startMarker 的首字符，就是安全的
        if (combined.includes(startMarker[0])) {
           // 极简处理，实际生产可以使用更复杂的 partial match
           pendingText = combined; 
        } else {
           const tc = textChunk(combined);
           if (tc) push(tc);
           pendingText = '';
        }
      }
    }
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      const text = chunk.toString();
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      const push = (data) => this.push(data);
      for (const line of lines) processLine(line, push);
      callback();
    },
    flush(callback) {
      if (streamEnded) {
        if (logger) logger.save();
        callback();
        return;
      }
      const push = (data) => this.push(data);
      if (lineBuffer) { processLine(lineBuffer, push); lineBuffer = ''; }
      if (pendingText) { const tc = textChunk(pendingText); if (tc) this.push(tc); pendingText = ''; }
      if (contentBuffer) {
        const { toolCalls, cleanContent } = delimiter.parse(contentBuffer, logger);
        if (cleanContent) { const tc = textChunk(cleanContent); if (tc) this.push(tc); }
        if (toolCalls.length > 0) {
          this.push(toolCallChunks(toolCalls));
          this.push(finishChunk('tool_calls'));
        } else { this.push(finishChunk('stop')); }
      } else { this.push(finishChunk('stop')); }
      this.push('data: [DONE]\n\n');
      if (logger) logger.save();
      callback();
    }
  });
}

// ============ URL 解析 ============
function extractUpstream(reqUrl) {
  const match = reqUrl.match(/^\/(https?:\/\/.+)$/);
  if (!match) return null;
  return match[1];
}

// ============ 主处理 ============
async function handleRequest(req, res) {
  const logger = new RequestLogger();
  const upstream = extractUpstream(req.originalUrl);
  
  // 1. 验证上游 URL (SSRF 防护)
  const validation = await validateUpstream(upstream);
  if (!validation.valid) {
    logger.log('BLOCKED', validation.error);
    logger.save();
    return res.status(403).json({
      error: { message: `Access denied: ${validation.error}`, type: 'security_error' }
    });
  }

  logger.log('REQUEST', `${req.method} ${upstream}`);

  const isChatCompletions = upstream.includes('/chat/completions');
  let body = req.body;
  const hasTools = isChatCompletions && body?.tools?.length > 0;
  const isStream = body?.stream === true;
  
  // 检查历史消息是否包含 tool 相关内容 (用于清洗历史)
  const hasToolHistory = body?.messages?.some(m => 
    m.role === 'tool' || (m.role === 'assistant' && m.tool_calls?.length)
  );

  // 只要有 tools 或者历史里有 tool，都需要经过 transform
  const needsTransform = isChatCompletions && (hasTools || hasToolHistory);
  
  if (needsTransform) {
    body = transformRequest(body, logger, hasTools);
  }

  const headers = {};
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
  if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
  headers['Content-Type'] = 'application/json';

  try {
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(body),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.log('UPSTREAM_ERROR', `${upstreamRes.status}: ${errText}`);
      logger.save();
      return res.status(upstreamRes.status).send(errText);
    }

    // A. 流式 + 需要解析工具
    if (isStream && hasTools) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const transformer = createStreamTransformer(logger);
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      transformer.on('data', c => res.write(c));
      transformer.on('end', () => res.end());
      transformer.on('error', () => res.end());

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            transformer.write(decoder.decode(value, { stream: true }));
          }
          transformer.end();
        } catch (err) { transformer.end(); }
      })();
      return;
    }

    // B. 流式 + 透传 (无工具)
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstreamRes.body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
          logger.save();
        } catch (err) { res.end(); }
      })();
      return;
    }

    // C. 非流式
    const data = await upstreamRes.json();

    if (hasTools && data.choices?.[0]?.message?.content) {
      const { toolCalls, cleanContent } = delimiter.parse(data.choices[0].message.content, logger);
      if (toolCalls.length > 0) {
        data.choices[0].message.tool_calls = toolCalls;
        data.choices[0].message.content = cleanContent || null;
        data.choices[0].finish_reason = 'tool_calls';
      }
    }

    logger.save();
    res.json(data);

  } catch (err) {
    logger.log('PROXY_ERROR', err.message);
    logger.save();
    res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
  }
}

// ============ 路由 ============
app.use((req, res, next) => {
  handleRequest(req, res).catch(next);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { message: err.message, type: 'server_error' } });
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║       🚀 AnyToolCall Proxy Started                     ║
╠════════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(49)}║
║  Local Net Access: ${(ALLOW_LOCAL_NET ? 'ALLOWED ⚠️' : 'BLOCKED 🔒').padEnd(38)}║
║  Logging: ${(LOG_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(46)}║
║                                                        ║
║  Features:                                             ║
║  ✓ AnyToolCall Protocol (Unicode Delimiters)           ║
║  ✓ Auto-merge adjacent same-role messages              ║
║  ✓ Auto-sanitize tool history for non-tool requests    ║
║  ✓ SSRF Protection                                     ║
║                                                        ║
║  Usage:                                                ║
║  POST http://localhost:${PORT}/{upstream_api_url}           ║
╚════════════════════════════════════════════════════════╝
  `);
});
