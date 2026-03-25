/**
 * 考试系统主逻辑
 */
const ExamApp = (() => {
    let examData = null;
    let selectedQuestions = [];
    let shuffleMaps = [];
    let userAnswers = [];
    let playerID = '';
    let currentIndex = 0;
    let _credential = null;

    const $ = id => document.getElementById(id);

    function init() {
        $('start-btn').addEventListener('click', startExam);
        $('prev-btn').addEventListener('click', prevQuestion);
        $('next-btn').addEventListener('click', nextQuestion);
        $('submit-btn').addEventListener('click', submitExam);
        $('retry-btn').addEventListener('click', () => location.reload());
        $('copy-credential-btn').addEventListener('click', copyCredential);
        $('download-cert-btn').addEventListener('click', downloadCertificate);
        $('player-id-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') startExam();
        });
        loadExamInfo();
    }

    async function loadExamInfo() {
        try {
            const data = await loadExamData();
            var count = (data.settings && data.settings.questionsPerExam) || ExamConfig.QUESTIONS_PER_EXAM;
            if (count <= 0) count = data.questions.length;
            count = Math.min(count, data.questions.length);
            var el = $('info-question-count');
            if (el) el.textContent = '📝 共 ' + count + ' 道选择题';
        } catch (e) {
            // 加载失败时保持默认显示
        }
    }

    async function loadExamData() {
        const response = await fetch(ExamConfig.DATA_PATH + 'exam.enc');
        if (!response.ok) throw new Error('考试数据文件不存在，请联系管理员初始化题库');
        const encrypted = await response.text();
        const decrypted = await CryptoUtil.decrypt(encrypted.trim(), ExamConfig.getSiteKey());
        return JSON.parse(decrypted);
    }

    async function startExam() {
        playerID = $('player-id-input').value.trim();
        if (!playerID) {
            showToast('请输入你的 MC 正版 ID', 'error');
            return;
        }
        if (!/^[A-Za-z0-9_]{3,16}$/.test(playerID)) {
            showToast('ID 格式无效（3-16位，仅字母数字下划线）', 'error');
            return;
        }

        showLoading(true);
        try {
            examData = await loadExamData();

            // 动态读取答题数量（向后兼容：旧数据默认 15 题）
            var questionsPerExam = (examData.settings && examData.settings.questionsPerExam) || ExamConfig.QUESTIONS_PER_EXAM;
            // 如果设置为 0 或负数，表示答全部题
            if (questionsPerExam <= 0) questionsPerExam = examData.questions.length;
            // 不能超过题库数量
            questionsPerExam = Math.min(questionsPerExam, examData.questions.length);
            examData._questionsPerExam = questionsPerExam;

            if (!examData.questions || examData.questions.length < 1) {
                throw new Error('题库为空，请联系管理员');
            }

            selectRandomQuestions();
            userAnswers = new Array(selectedQuestions.length).fill(-1);
            currentIndex = 0;
            showScreen('exam-screen');
            renderQuestion();
            updateProgress();
        } catch (e) {
            showToast(e.message || '考试数据加载失败', 'error');
        } finally {
            showLoading(false);
        }
    }

    function selectRandomQuestions() {
        const pool = examData.questions.slice();
        selectedQuestions = [];
        shuffleMaps = [];
        var questionsPerExam = examData._questionsPerExam;

        // Fisher-Yates shuffle
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        selectedQuestions = pool.slice(0, questionsPerExam);

        // Shuffle options for each question
        selectedQuestions.forEach(() => {
            const indices = [0, 1, 2, 3];
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
            }
            shuffleMaps.push(indices);
        });
    }

    function renderQuestion() {
        const q = selectedQuestions[currentIndex];
        const map = shuffleMaps[currentIndex];
        const labels = ['A', 'B', 'C', 'D'];

        $('question-number').textContent = '第 ' + (currentIndex + 1) + ' / ' + selectedQuestions.length + ' 题';
        $('question-category').textContent = q.category || '';
        $('question-stem').textContent = q.stem;

        const container = $('options-container');
        container.innerHTML = '';

        map.forEach((originalIdx, displayIdx) => {
            const div = document.createElement('div');
            div.className = 'option' + (userAnswers[currentIndex] === displayIdx ? ' selected' : '');
            div.innerHTML = '<span class="option-label">' + labels[displayIdx] + '</span>' +
                '<span class="option-text">' + escapeHtml(q.options[originalIdx]) + '</span>';
            div.addEventListener('click', () => selectOption(displayIdx));
            container.appendChild(div);
        });

        $('prev-btn').disabled = currentIndex === 0;
        $('next-btn').style.display = currentIndex < selectedQuestions.length - 1 ? '' : 'none';
        $('submit-btn').style.display = currentIndex === selectedQuestions.length - 1 ? '' : 'none';

        renderNavDots();
    }

    function renderNavDots() {
        const nav = $('question-nav');
        nav.innerHTML = '';
        selectedQuestions.forEach((_, i) => {
            const dot = document.createElement('span');
            dot.className = 'nav-dot';
            if (i === currentIndex) dot.classList.add('current');
            if (userAnswers[i] !== -1) dot.classList.add('answered');
            dot.textContent = i + 1;
            dot.addEventListener('click', () => {
                currentIndex = i;
                renderQuestion();
                updateProgress();
            });
            nav.appendChild(dot);
        });
    }

    function selectOption(displayIdx) {
        userAnswers[currentIndex] = displayIdx;
        renderQuestion();
        updateProgress();
    }

    function prevQuestion() {
        if (currentIndex > 0) {
            currentIndex--;
            renderQuestion();
            updateProgress();
        }
    }

    function nextQuestion() {
        if (currentIndex < selectedQuestions.length - 1) {
            currentIndex++;
            renderQuestion();
            updateProgress();
        }
    }

    function updateProgress() {
        const answered = userAnswers.filter(a => a !== -1).length;
        const total = selectedQuestions.length;
        const pct = Math.round(answered / total * 100);
        $('progress-fill').style.width = pct + '%';
        $('progress-text').textContent = '已答 ' + answered + '/' + total;
    }

    async function submitExam() {
        const unanswered = userAnswers.filter(a => a === -1).length;
        if (unanswered > 0) {
            if (!confirm('还有 ' + unanswered + ' 题未作答，确定提交吗？未作答将视为答错。')) return;
        }

        showLoading(true);
        try {
            let correct = 0;
            const total = selectedQuestions.length;

            for (let i = 0; i < total; i++) {
                const q = selectedQuestions[i];
                const displayIdx = userAnswers[i];
                if (displayIdx === -1) continue;

                const originalIdx = shuffleMaps[i][displayIdx];
                const hash = await CryptoUtil.hashAnswer(examData.salt, q.id, originalIdx);
                if (hash === q.answerHash) correct++;
            }

            const score = correct === total ? 100 : Math.floor(correct / total * 100);
            const passed = score >= ExamConfig.PASS_SCORE;

            showScreen('result-screen');
            $('result-score').textContent = score;
            $('result-score').style.color = passed ? '#4ade80' : '#f87171';
            $('result-correct').textContent = correct + '/' + total;

            if (passed) {
                $('result-status').textContent = '🎉 恭喜通过！';
                $('result-status').className = 'result-status pass';
                $('result-message').textContent = '你已通过入群考试，请将凭证码发送给群主完成验证。';
                $('credential-section').style.display = 'block';
                $('fail-section').style.display = 'none';

                // 收集作答记录用于生成凭证
                var allQuestionIds = examData.questions.map(function(q) { return q.id; });
                var answeredIds = [];
                var answeredOriginalIndices = [];
                for (var ci = 0; ci < total; ci++) {
                    answeredIds.push(selectedQuestions[ci].id);
                    answeredOriginalIndices.push(shuffleMaps[ci][userAnswers[ci]]);
                }
                var credTimestamp = Math.floor(Date.now() / 1000);
                _credential = await CryptoUtil.generateCredential(playerID, credTimestamp, allQuestionIds, answeredIds, answeredOriginalIndices);
                $('credential-code').textContent = _credential.code;
                $('credential-time').textContent = _credential.timeStr;
                $('credential-player').textContent = _credential.playerID;
            } else {
                $('result-status').textContent = '❌ 未通过';
                $('result-status').className = 'result-status fail';
                $('result-message').textContent = '很遗憾，你答对了 ' + correct + '/' + total + ' 题。必须满分才能通过，请重新阅读服务器公告后再试。';
                $('credential-section').style.display = 'none';
                $('fail-section').style.display = 'block';
            }

            // 异步通知（静默失败，不影响考试流程）
            _notifyResult(
                playerID,
                passed,
                score,
                correct,
                total,
                passed && _credential ? _credential.code : null,
                Date.now()
            );
        } catch (e) {
            showToast('评分出错: ' + e.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    function _notifyResult(pid, passed, score, correct, total, credential, timestamp) {
        if (!examData || !examData.settings || !examData.settings.notifyWorkerUrl) return;
        var workerUrl = examData.settings.notifyWorkerUrl;
        fetch(workerUrl + '/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerID: pid,
                passed: passed,
                score: score,
                correct: correct,
                total: total,
                credential: credential,
                timestamp: timestamp
            })
        }).catch(function() { /* 静默失败 */ });
    }

    function copyCredential() {
        if (!_credential) return;
        const code = _credential.code;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(() => {
                showToast('凭证码已复制到剪贴板', 'success');
            }).catch(() => fallbackCopy(code));
        } else {
            fallbackCopy(code);
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('凭证码已复制', 'success');
    }

    function downloadCertificate() {
        if (!_credential) return;
        const cred = _credential;
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 520;
        const ctx = canvas.getContext('2d');
        const fontStack = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

        // Background
        const grad = ctx.createLinearGradient(0, 0, 900, 520);
        grad.addColorStop(0, '#1a1a2e');
        grad.addColorStop(1, '#16213e');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 900, 520);

        // Border
        ctx.strokeStyle = '#d4a843';
        ctx.lineWidth = 4;
        ctx.strokeRect(20, 20, 860, 480);
        ctx.strokeStyle = 'rgba(212,168,67,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(30, 30, 840, 460);

        // Title
        ctx.fillStyle = '#d4a843';
        ctx.font = 'bold 36px ' + fontStack;
        ctx.textAlign = 'center';
        ctx.fillText('入群考试通过凭证', 450, 90);

        // Divider
        ctx.strokeStyle = '#d4a843';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(200, 110);
        ctx.lineTo(700, 110);
        ctx.stroke();

        // Content
        var leftX = 120, y = 170, lh = 50;

        ctx.textAlign = 'left';
        ctx.fillStyle = '#a0a0a0';
        ctx.font = '18px ' + fontStack;
        ctx.fillText('玩家 ID', leftX, y);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px ' + fontStack;
        ctx.fillText(cred.playerID, leftX + 130, y);

        y += lh;
        ctx.fillStyle = '#a0a0a0';
        ctx.font = '18px ' + fontStack;
        ctx.fillText('通过时间', leftX, y);
        ctx.fillStyle = '#ffffff';
        ctx.font = '22px ' + fontStack;
        ctx.fillText(cred.timeStr, leftX + 130, y);

        y += lh;
        ctx.fillStyle = '#a0a0a0';
        ctx.font = '18px ' + fontStack;
        ctx.fillText('考试成绩', leftX, y);
        ctx.fillStyle = '#4ade80';
        ctx.font = 'bold 24px ' + fontStack;
        ctx.fillText('100 分 — 满分通过', leftX + 130, y);

        y += lh + 20;
        ctx.fillStyle = '#a0a0a0';
        ctx.font = '16px ' + fontStack;
        ctx.fillText('验证凭证码:', leftX, y);

        y += 35;
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(leftX - 10, y - 25, 680, 45);
        ctx.strokeStyle = '#30363d';
        ctx.lineWidth = 1;
        ctx.strokeRect(leftX - 10, y - 25, 680, 45);
        ctx.fillStyle = '#58a6ff';
        ctx.font = '18px Consolas, "Courier New", monospace';
        ctx.fillText(cred.code, leftX + 10, y + 2);

        // Footer
        ctx.fillStyle = '#555';
        ctx.font = '14px ' + fontStack;
        ctx.textAlign = 'center';
        ctx.fillText('请将此凭证发送给群主以完成入群验证 · 凭证码可由管理员在线验证真伪', 450, 480);

        // Download
        const link = document.createElement('a');
        link.download = '入群考试凭证_' + cred.playerID + '_' + cred.timestamp + '.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    }

    // --- Utilities ---

    function showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        $(screenId).classList.add('active');
    }

    function showToast(msg, type) {
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function showLoading(show) {
        $('loading-overlay').style.display = show ? 'flex' : 'none';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', () => ExamApp.init());
