/**
 * 考试系统配置
 */
const ExamConfig = (() => {
    // 站点密钥 - 字符码混淆存储（XOR 0x5A）
    // 用于加密 exam.enc，提供基本保护层
    // 真正的答案安全依赖于 SHA-256 单向哈希
    const _k = [31,34,59,55,9,35,41,104,106,104,108,123,9,63,57,47,40,63,17,105,35,121,10,54,59,46,60,53,40,55];
    const _x = 0x5A;

    function getSiteKey() {
        return _k.map(function(c) { return String.fromCharCode(c ^ _x); }).join('');
    }

    return {
        QUESTIONS_PER_EXAM: 15,
        TOTAL_SCORE: 100,
        PASS_SCORE: 100,
        VERSION: 1,
        DATA_PATH: 'data/',
        SYNC_WORKER_URL: 'https://exam-sync.sz7372797.workers.dev',
        getSiteKey: getSiteKey
    };
})();
