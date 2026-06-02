/**
 * GitHub 同步模块 — 通过 Cloudflare Worker 代理读写仓库文件
 * Worker 持有 GitHub PAT，浏览器只需知道 Worker URL 和管理员通信密钥
 */
const GitHubSync = (() => {
    const STORAGE_KEY = 'exam_sync_config';

    /** 获取已保存的同步配置 */
    function getConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch { return null; }
    }

    function normalizeConfig(workerUrl, adminSecret) {
        workerUrl = (workerUrl || '').trim().replace(/\/+$/, '');
        adminSecret = (adminSecret || '').trim();
        if (!workerUrl) throw new Error('请输入 Worker 地址');
        if (!adminSecret) throw new Error('请输入管理员通信密钥');
        try { new URL(workerUrl); } catch {
            throw new Error('Worker 地址格式不正确');
        }
        return { workerUrl, adminSecret };
    }

    /** 保存同步配置 */
    function saveConfig(workerUrl, adminSecret, verification) {
        const config = normalizeConfig(workerUrl, adminSecret);
        if (verification) {
            config.verifiedAt = Date.now();
            config.repo = verification.repo || null;
            config.canPush = !!verification.canPush;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }

    /** 清除同步配置 */
    function clearConfig() {
        localStorage.removeItem(STORAGE_KEY);
    }

    /** 是否已配置同步 */
    function isConfigured() {
        return getConfig() !== null;
    }

    function isVerified() {
        const config = getConfig();
        return !!(config && config.verifiedAt && config.canPush);
    }

    /** 从仓库读取文件 */
    async function readFile(filePath) {
        const config = getConfig();
        if (!config) throw new Error('未配置同步');

        const url = config.workerUrl + '/api/read?file=' + encodeURIComponent(filePath);
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'X-Admin-Secret': config.adminSecret }
        });

        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'Worker 请求失败 (' + resp.status + ')');
        }

        return resp.json();
    }

    /** 写入文件到仓库（支持多文件，支持乐观锁 SHA） */
    async function writeFiles(files, message, questionCount) {
        const config = getConfig();
        if (!config) throw new Error('未配置同步');

        const url = config.workerUrl + '/api/write';
        const payload = { files, message };
        if (typeof questionCount === 'number') {
            payload.questionCount = questionCount;
        }
        const resp = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Secret': config.adminSecret
            },
            body: JSON.stringify(payload)
        });

        const data = await resp.json().catch(() => ({}));

        // 409 = 乐观锁冲突：文件已被他人修改
        if (resp.status === 409 && data.conflict) {
            const err = new Error('CONFLICT');
            err.conflict = true;
            err.conflictData = data;
            throw err;
        }

        if (!resp.ok) {
            throw new Error(data.error || 'Worker 请求失败 (' + resp.status + ')');
        }

        return data;
    }

    /** 测试连接（使用诊断接口） */
    async function testConnectionWith(workerUrl, adminSecret) {
        const config = normalizeConfig(workerUrl, adminSecret);

        const url = config.workerUrl + '/api/check';
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'X-Admin-Secret': config.adminSecret }
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
            throw new Error(data.error || '连接失败 (' + resp.status + ')');
        }
        return { success: true, repo: data.repo, canPush: data.canPush, message: data.message };
    }

    /** 测试已保存的连接 */
    async function testConnection() {
        const config = getConfig();
        if (!config) throw new Error('未配置同步');
        return testConnectionWith(config.workerUrl, config.adminSecret);
    }

    return {
        getConfig,
        normalizeConfig,
        saveConfig,
        clearConfig,
        isConfigured,
        isVerified,
        readFile,
        writeFiles,
        testConnectionWith,
        testConnection
    };
})();
