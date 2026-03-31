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
 *   NAPCAT_CUSTOM_AUTH - NapCat WAF 自定义鉴权密钥（对应 x-custom-auth）
 */

const REQUIRED_NAPCAT_HOSTNAME = 'napcat.miyakko.de';
const REQUIRED_NAPCAT_UA_KEYWORD = 'Cloudflare-Workers';

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

    const url = new URL(request.url);
    const path = url.pathname;

    // /api/notify 是公开端点，无需管理员密钥
    if (path !== '/api/notify') {
      const secret = request.headers.get('X-Admin-Secret');
      if (!secret || secret !== env.ADMIN_SECRET) {
        return jsonResponse({ error: '未授权' }, 403, cors);
      }
    }

    try {
      // GET /api/check  — 诊断连接（验证 token + 仓库可访问性）
      if (request.method === 'GET' && path === '/api/check') {
        const diag = await githubCheckAccess(env);
        return jsonResponse(diag, diag.ok ? 200 : 502, cors);
      }

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
        if (!body.files || !Array.isArray(body.files)) {
          return jsonResponse({ error: '缺少 files 数组' }, 400, cors);
        }
        for (const f of body.files) {
          if (!f.path || !isAllowedPath(f.path)) {
            return jsonResponse({ error: '不允许的文件路径: ' + f.path }, 400, cors);
          }
        }

        // 防删库：校验题目数量（客户端必须附带 questionCount）
        const minQ = parseInt(env.MIN_QUESTIONS) || 5;
        if (typeof body.questionCount !== 'number' || body.questionCount < minQ) {
          return jsonResponse({
            error: '题目数量不足：至少需要 ' + minQ + ' 道题才能同步（当前 ' + (body.questionCount || 0) + ' 道）'
          }, 400, cors);
        }

        // 写入前先验证仓库可达
        const access = await githubCheckAccess(env);
        if (!access.ok) {
          return jsonResponse({ error: '无法访问仓库: ' + access.error }, 502, cors);
        }

        const result = await githubPutFiles(env, body.files, body.message || '更新考试数据');
        if (result.conflict) {
          return jsonResponse(result, 409, cors);
        }
        return jsonResponse(result, 200, cors);
      }

      // POST /api/notify — 考试结果通知（无需 ADMIN_SECRET，考生端调用）
      if (request.method === 'POST' && path === '/api/notify') {
        // 未配置通知时静默成功，不暴露配置状态
        if (!env.NAPCAT_URL || !env.NOTIFY_TARGETS) {
          return jsonResponse({ ok: true }, 200, cors);
        }
        const napcatConfig = getNapcatConfig(env);
        if (!napcatConfig.ok) {
          return jsonResponse({ error: napcatConfig.error }, 500, cors);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: '请求体格式错误' }, 400, cors);
        }

        const { playerID, passed, score, correct, total, credential, timestamp } = body;

        // 输入校验，防止注入
        if (typeof playerID !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(playerID)) {
          return jsonResponse({ error: '参数无效' }, 400, cors);
        }
        if (typeof passed !== 'boolean') {
          return jsonResponse({ error: '参数无效' }, 400, cors);
        }

        let targets;
        try {
          targets = JSON.parse(env.NOTIFY_TARGETS);
          if (!Array.isArray(targets)) throw new Error();
        } catch {
          return jsonResponse({ error: 'NOTIFY_TARGETS 配置格式错误' }, 500, cors);
        }

        // 构建消息内容
        const ts = typeof timestamp === 'number' ? timestamp : Date.now();
        const timeStr = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const status = passed ? '✅ 通过' : '❌ 未通过';

        let content = '【入群考试通知】\n'
          + '玩家：' + playerID + '\n'
          + '结果：' + status + '\n'
          + '得分：' + (score || 0) + ' 分（' + (correct || 0) + '/' + (total || 0) + ' 题正确）\n'
          + '时间：' + timeStr;

        if (passed && credential) {
          content += '\n凭证码：' + credential;
        }

        // 逐个目标发送，失败不中止
        const errors = [];

        for (const target of targets) {
          if (!target || typeof target.id !== 'number') continue;
          const mode = target.mode || 'all';
          if (mode === 'pass_only' && !passed) continue;
          if (mode === 'fail_only' && passed) continue;

          const endpoint = target.type === 'group' ? '/send_group_msg' : '/send_private_msg';
          const idKey = target.type === 'group' ? 'group_id' : 'user_id';
          const napBody = { [idKey]: target.id, message: content };

          try {
            const napResp = await fetch(buildNapcatApiUrl(env.NAPCAT_URL, endpoint), {
              method: 'POST',
              headers: napcatConfig.headers,
              body: JSON.stringify(napBody)
            });
            const napData = await napResp.json().catch(() => ({}));
            if (!napResp.ok || napData.status === 'failed') {
              errors.push(String(target.id) + ': ' + (napData.message || 'HTTP ' + napResp.status));
            }
          } catch (e) {
            errors.push(String(target.id) + ': ' + e.message);
          }
        }

        return jsonResponse({ ok: true, errors: errors.length > 0 ? errors : undefined }, 200, cors);
      }

      return jsonResponse({ error: '未知路由' }, 404, cors);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500, cors);
    }
  }
};

function getNapcatConfig(env) {
  if (!env.NAPCAT_TOKEN) {
    return { ok: false, error: '未配置 NAPCAT_TOKEN' };
  }
  if (!env.NAPCAT_CUSTOM_AUTH) {
    return { ok: false, error: '未配置 NAPCAT_CUSTOM_AUTH' };
  }

  let napcatUrl;
  try {
    napcatUrl = new URL(env.NAPCAT_URL);
  } catch {
    return { ok: false, error: 'NAPCAT_URL 格式错误' };
  }
  if (napcatUrl.hostname !== REQUIRED_NAPCAT_HOSTNAME) {
    return { ok: false, error: 'NAPCAT_URL Hostname 必须为 ' + REQUIRED_NAPCAT_HOSTNAME };
  }

  return {
    ok: true,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.NAPCAT_TOKEN,
      'User-Agent': REQUIRED_NAPCAT_UA_KEYWORD + ' ExamSync-Worker',
      'x-custom-auth': env.NAPCAT_CUSTOM_AUTH
    }
  };
}

function buildNapcatApiUrl(base, endpoint) {
  return base.replace(/\/+$/, '') + endpoint;
}

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
    // 区分「文件不存在」和「仓库不可访问」
    const body = await resp.json().catch(() => ({}));
    if (body.message === 'Not Found') {
      // 可能是仓库不可访问，再验证一次
      const access = await githubCheckAccess(env);
      if (!access.ok) {
        throw new Error('仓库不可访问（' + access.error + '）。请检查 GITHUB_TOKEN 权限、GITHUB_OWNER 和 GITHUB_REPO 是否正确');
      }
    }
    return { exists: false, content: null, sha: null };
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('GitHub API 错误 (' + resp.status + '): ' + text);
  }

  const data = await resp.json();
  const content = atob(data.content.replace(/\n/g, ''));
  return { exists: true, content: content, sha: data.sha };
}

/** 检查仓库可访问性 */
async function githubCheckAccess(env) {
  // 检查环境变量
  if (!env.GITHUB_TOKEN) return { ok: false, error: '未设置 GITHUB_TOKEN' };
  if (!env.GITHUB_OWNER) return { ok: false, error: '未设置 GITHUB_OWNER' };
  if (!env.GITHUB_REPO) return { ok: false, error: '未设置 GITHUB_REPO' };

  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const resp = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ExamSync-Worker'
    }
  });

  if (resp.status === 404) {
    return { ok: false, error: '仓库 ' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + ' 不存在或 Token 无权访问' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, error: 'Token 无效或已过期 (' + resp.status + ')' };
  }
  if (!resp.ok) {
    return { ok: false, error: 'GitHub API 异常 (' + resp.status + ')' };
  }

  const repo = await resp.json();
  // 检查是否有 push 权限
  const canPush = repo.permissions && repo.permissions.push;
  return {
    ok: true,
    repo: repo.full_name,
    private: repo.private,
    canPush: canPush,
    message: canPush ? '连接正常，有写入权限' : '连接正常但无写入权限，请检查 PAT 的 Contents: Read and write 权限'
  };
}

/** 批量写入文件到 GitHub 仓库（逐个提交，支持乐观锁） */
async function githubPutFiles(env, files, message) {
  const results = [];
  for (const file of files) {
    // 乐观锁：如果客户端提供了 sha，直接使用（冲突检测）
    // 否则获取最新 sha（无锁模式）
    let fileSha = file.sha || null;
    if (!fileSha) {
      const existing = await githubGetFile(env, file.path);
      if (existing.exists) {
        fileSha = existing.sha;
      }
    }

    const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${file.path}`;

    const body = {
      message: message + ' [' + file.path + ']',
      content: btoa(unescape(encodeURIComponent(file.content))),
    };

    if (fileSha) {
      body.sha = fileSha;
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

    // 409 = SHA 不匹配，文件已被他人修改（乐观锁冲突）
    if (resp.status === 409) {
      const current = await githubGetFile(env, file.path);
      return {
        conflict: true,
        file: file.path,
        currentSha: current.sha,
        currentContent: current.content
      };
    }

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
