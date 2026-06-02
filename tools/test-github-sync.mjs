import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const storage = new Map();
const calls = [];
const context = {
  console,
  URL,
  Date,
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  fetch: async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, repo: 'owner/repo', canPush: true, message: 'ok' })
    };
  }
};

vm.createContext(context);
vm.runInContext(readFileSync('js/github-sync.js', 'utf8') + '\nglobalThis.GitHubSync = GitHubSync;', context);

const { GitHubSync } = context;

GitHubSync.saveConfig('https://old.example.com/', 'old-secret');
await GitHubSync.testConnectionWith('https://new.example.com/', ' new-secret ');
assert.equal(calls[0].url, 'https://new.example.com/api/check');
assert.equal(calls[0].options.headers['X-Admin-Secret'], 'new-secret');

const result = await GitHubSync.testConnectionWith('https://worker.example.com', 'secret');
GitHubSync.saveConfig('https://worker.example.com/', 'secret', result);
const saved = GitHubSync.getConfig();
assert.equal(saved.workerUrl, 'https://worker.example.com');
assert.equal(saved.canPush, true);
assert.equal(saved.repo, 'owner/repo');
assert.equal(GitHubSync.isVerified(), true);

assert.throws(() => GitHubSync.normalizeConfig('', 'secret'), /Worker 地址/);
assert.throws(() => GitHubSync.normalizeConfig('https://worker.example.com', ''), /通信密钥/);

console.log('GitHubSync tests passed');
