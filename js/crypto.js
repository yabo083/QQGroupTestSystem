/**
 * 加密工具模块 - 基于 Web Crypto API
 * AES-256-GCM 加密/解密、PBKDF2 密钥派生、SHA-256 哈希、HMAC-SHA256 签名
 */
const CryptoUtil = (() => {
    const PBKDF2_ITERATIONS = 100000;
    const SALT_LENGTH = 16;
    const IV_LENGTH = 12;

    function bufToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToBuf(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function bufToHex(bytes) {
        return Array.from(new Uint8Array(bytes))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    function generateSalt() {
        return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    }

    function generateIV() {
        return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    }

    /**
     * PBKDF2 派生 AES-256-GCM 密钥
     */
    async function deriveKey(password, salt) {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * AES-256-GCM 加密
     * @returns {string} "base64(salt).base64(iv).base64(ciphertext)"
     */
    async function encrypt(plaintext, password) {
        const salt = generateSalt();
        const iv = generateIV();
        const key = await deriveKey(password, salt);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(plaintext)
        );
        return bufToBase64(salt) + '.' + bufToBase64(iv) + '.' + bufToBase64(ciphertext);
    }

    /**
     * AES-256-GCM 解密
     * @param {string} encrypted "base64(salt).base64(iv).base64(ciphertext)"
     */
    async function decrypt(encrypted, password) {
        const parts = encrypted.split('.');
        if (parts.length !== 3) throw new Error('Invalid encrypted data format');
        const salt = new Uint8Array(base64ToBuf(parts[0]));
        const iv = new Uint8Array(base64ToBuf(parts[1]));
        const ciphertext = base64ToBuf(parts[2]);
        const key = await deriveKey(password, salt);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(plaintext);
    }

    /**
     * 答案哈希 - PBKDF2 高成本哈希 (防暴力遍历4选项)
     * 每次计算约50ms，暴力4选项需~200ms/题
     */
    async function hashAnswer(salt, questionId, optionIndex) {
        const data = salt + ':' + questionId + ':' + optionIndex;
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', encoder.encode(data), 'PBKDF2', false, ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: encoder.encode(salt + questionId), iterations: 50000, hash: 'SHA-256' },
            keyMaterial, 256
        );
        return bufToHex(bits);
    }

    /**
     * HMAC-SHA256 签名
     */
    async function hmacSign(secret, message) {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const signature = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(message)
        );
        return bufToHex(signature);
    }

    /**
     * 凭证编码：将题目索引+答案打包为紧凑字节流
     * 每题1字节: (sortedIndex << 2) | (answerIndex & 0x3)
     * @param {string[]} allQuestionIds 完整题库所有ID
     * @param {string[]} answeredIds 作答的15题ID
     * @param {number[]} answerIndices 对应的原始选项索引(0-3)
     * @returns {string} base64url 编码
     */
    function encodeAnswerData(allQuestionIds, answeredIds, answerIndices) {
        var sorted = allQuestionIds.slice().sort();
        var bytes = [];
        for (var i = 0; i < answeredIds.length; i++) {
            var qIdx = sorted.indexOf(answeredIds[i]);
            if (qIdx < 0) qIdx = 0;
            bytes.push((qIdx << 2) | (answerIndices[i] & 0x3));
        }
        var binary = '';
        for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    /**
     * 凭证解码：从base64url还原题目索引+答案
     * @param {string[]} allQuestionIds 完整题库所有ID
     * @param {string} encoded base64url 编码数据
     * @returns {Array<{questionId: string, answer: number}>}
     */
    function decodeAnswerData(allQuestionIds, encoded) {
        var sorted = allQuestionIds.slice().sort();
        var base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        var binary = atob(base64);
        var result = [];
        for (var i = 0; i < binary.length; i++) {
            var byte = binary.charCodeAt(i);
            var qIdx = byte >> 2;
            var ans = byte & 0x3;
            result.push({
                questionId: qIdx < sorted.length ? sorted[qIdx] : null,
                answer: ans
            });
        }
        return result;
    }

    /**
     * 生成通过凭证码（答案指纹模型，无需共享密钥）
     * 格式: PASS-{playerID}-{timestamp}-{base64urlData}-{checksum8hex}
     * base64urlData: 紧凑编码的题目+答案（~20字符）
     * checksum: SHA-256(playerID|timestamp|data) 前8位hex
     * 管理员验证时：解码data → 对照完整题库检查每题答案是否正确
     */
    async function generateCredential(playerID, timestamp, allQuestionIds, answeredIds, answerIndices) {
        var data = encodeAnswerData(allQuestionIds, answeredIds, answerIndices);
        var checksumInput = playerID + '|' + timestamp + '|' + data;
        var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(checksumInput));
        var checksum = bufToHex(hash).substring(0, 8);
        return {
            code: 'PASS-' + playerID + '-' + timestamp + '-' + data + '-' + checksum,
            playerID: playerID,
            timestamp: timestamp,
            timeStr: new Date(timestamp * 1000).toLocaleString('zh-CN')
        };
    }

    /**
     * 管理员验证凭证码 — 使用完整题库（含correctIndex）逐题校验
     * @param {Array} allQuestions 完整题库数组（含 id, correctIndex）
     * @param {string} code 凭证码
     */
    async function verifyCredential(allQuestions, code) {
        var match = code.trim().match(/^PASS-([A-Za-z0-9_]+)-(\d+)-([A-Za-z0-9_-]+)-([0-9a-f]{8})$/);
        if (!match) return { valid: false, error: '凭证码格式无效' };

        var playerID = match[1];
        var timestamp = parseInt(match[2], 10);
        var encodedData = match[3];
        var providedChecksum = match[4];

        // 验证 checksum 完整性
        var checksumInput = playerID + '|' + timestamp + '|' + encodedData;
        var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(checksumInput));
        var expectedChecksum = bufToHex(hash).substring(0, 8);
        if (providedChecksum !== expectedChecksum) {
            return { valid: false, error: '凭证校验和不匹配，数据可能被篡改', playerID: playerID };
        }

        // 解码答案数据
        var allIds = allQuestions.map(function(q) { return q.id; });
        var decoded;
        try {
            decoded = decodeAnswerData(allIds, encodedData);
        } catch (e) {
            return { valid: false, error: '凭证数据解码失败', playerID: playerID };
        }

        // 逐题验证答案
        var questionMap = {};
        allQuestions.forEach(function(q) { questionMap[q.id] = q; });

        var correctCount = 0;
        var totalCount = decoded.length;
        var details = [];

        for (var i = 0; i < decoded.length; i++) {
            var item = decoded[i];
            var q = item.questionId ? questionMap[item.questionId] : null;
            if (!q) {
                details.push({ stem: '(未知题目)', correct: false });
                continue;
            }
            var isCorrect = item.answer === q.correctIndex;
            if (isCorrect) correctCount++;
            details.push({ stem: q.stem, selected: q.options[item.answer], correct: isCorrect });
        }

        var allCorrect = correctCount === totalCount && totalCount > 0;
        var timeStr = new Date(timestamp * 1000).toLocaleString('zh-CN');
        var timeDiff = Math.abs(Date.now() / 1000 - timestamp);

        return {
            valid: allCorrect,
            playerID: playerID,
            timestamp: timestamp,
            timeStr: timeStr,
            correctCount: correctCount,
            totalCount: totalCount,
            details: details,
            isRecent: timeDiff < 86400 * 7,
            warning: !allCorrect ? '答案验证未全部通过 (' + correctCount + '/' + totalCount + ')' :
                     timeDiff > 86400 * 7 ? '凭证已超过7天，请注意时效性' : null,
            error: allCorrect ? null : '答案校验失败，凭证无效'
        };
    }

    /**
     * 生成随机十六进制字符串
     * @param {number} byteLength 字节数（输出 hex 长度为 byteLength * 2）
     */
    function generateRandomHex(byteLength) {
        const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
        return bufToHex(bytes);
    }

    return {
        encrypt,
        decrypt,
        hashAnswer,
        hmacSign,
        generateCredential,
        verifyCredential,
        generateRandomHex
    };
})();
