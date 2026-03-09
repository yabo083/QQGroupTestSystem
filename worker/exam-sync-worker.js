/**
 * Cloudflare Worker — 入群考试系统 GitHub 同步代理
 * 
 * 功能：代理管理员的 GitHub API 请求，PAT 存储在 Worker 环境变量中，浏览器不接触 token。
 * 
 * 环境变量（在 Cloudflare Dashboard 设置）：
 *   GITHUB_TOKEN   - GitHub Fine-grained PAT（仅需单仓库 Contents 读写权限）
 *   GITHUB_OWNER   - GitHub 用户名（如 yabo083）
 *   GITHUB_REPO    - 仓库名（如 QQGroupTestSystem）
 *   ADMIN_SECRET   - 管理员通信密钥（随机字符串，防止任何人调用 Worker）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Max-Age': '86400',
};

function corsHeaders(origin, env) {
  // 只允许你自己的 Pages 域名
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const headers = { ...CORS_HEADERS };
  if (allowed.length === 0 || allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
  } else {
    headers['Access-Control-Allow-Origin'] = 'null'; // 拒绝
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 验证管理员密钥
    const secret = request.headers.get('X-Admin-Secret');
    if (!secret || secret !== env.ADMIN_SECRET) {
      return jsonResponse({ error: '未授权' }, 403, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/read?file=data/exam.enc  — 读取仓库文件
      if (request.method === 'GET' && path === '/api/read') {
        const file = url.searchParams.get('file');
        if (!file || !isAllowedPath(file)) {
          return jsonResponse({ error: '不允许的文件路径' }, 400, cors);
        }
        const result = await githubGetFile(env, file);
        return jsonResponse(result, 200, cors);
      }

      // PUT /api/write  — 写入仓库文件（支持多文件批量提交）
      if (request.method === 'PUT' && path === '/api/write') {
        const body = await request.json();
        // body: { files: [{ path: "data/exam.enc", content: "..." }], message: "更新题库" }
        if (!body.files || !Array.isArray(body.files)) {
          return jsonResponse({ error: '缺少 files 数组' }, 400, cors);
        }
        for (const f of body.files) {
          if (!f.path || !isAllowedPath(f.path)) {
            return jsonResponse({ error: '不允许的文件路径: ' + f.path }, 400, cors);
          }
        }
        const result = await githubPutFiles(env, body.files, body.message || '更新考试数据');
        return jsonResponse(result, 200, cors);
      }

      return jsonResponse({ error: '未知路由' }, 404, cors);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500, cors);
    }
  }
};

/** 只允许 data 目录下的 .enc 文件 */
function isAllowedPath(filePath) {
  return /^data\/[a-zA-Z0-9_-]+\.enc$/.test(filePath);
}

/** 从 GitHub 仓库读取文件 */
async function githubGetFile(env, filePath) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}`;
  const resp = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ExamSync-Worker'
    }
  });

  if (resp.status === 404) {
    return { exists: false, content: null, sha: null };
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('GitHub API 错误 (' + resp.status + '): ' + text);
  }

  const data = await resp.json();
  // GitHub 返回 base64 编码的内容
  const content = atob(data.content.replace(/\n/g, ''));
  return { exists: true, content: content, sha: data.sha };
}

/** 批量写入文件到 GitHub 仓库（逐个提交） */
async function githubPutFiles(env, files, message) {
  const results = [];
  for (const file of files) {
    // 先获取现有文件的 sha（更新需要）
    const existing = await githubGetFile(env, file.path);
    const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${file.path}`;

    const body = {
      message: message + ' [' + file.path + ']',
      content: btoa(unescape(encodeURIComponent(file.content))),
    };

    if (existing.exists) {
      body.sha = existing.sha;
    }

    const resp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ExamSync-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('写入 ' + file.path + ' 失败 (' + resp.status + '): ' + text);
    }

    const data = await resp.json();
    results.push({ path: file.path, sha: data.content.sha });
  }
  return { success: true, files: results };
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
