/**
 * 管理面板逻辑
 */
const AdminApp = (() => {
    let bankData = null;
    let adminPassword = '';
    let isNewSetup = false;
    let editingQuestionId = null;
    let hasUnsavedChanges = false;

    const $ = id => document.getElementById(id);

    async function init() {
        bindEvents();

        // Try to load existing bank
        try {
            const response = await fetch(ExamConfig.DATA_PATH + 'bank.enc');
            if (response.ok) {
                isNewSetup = false;
                showScreen('login-screen');
            } else {
                isNewSetup = true;
                showScreen('setup-screen');
            }
        } catch (e) {
            isNewSetup = true;
            showScreen('setup-screen');
        }

        // Warn about unsaved changes
        window.addEventListener('beforeunload', e => {
            if (hasUnsavedChanges) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    function bindEvents() {
        // Login
        $('login-btn').addEventListener('click', handleLogin);
        $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

        // Setup
        $('setup-btn').addEventListener('click', handleSetup);
        $('setup-password-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') handleSetup(); });

        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        // Question management
        $('add-question-btn').addEventListener('click', () => showQuestionModal());
        $('modal-save-btn').addEventListener('click', saveQuestion);
        $('modal-cancel-btn').addEventListener('click', hideQuestionModal);

        // Close modal on backdrop click
        $('question-modal').addEventListener('click', e => {
            if (e.target === $('question-modal')) hideQuestionModal();
        });

        // Credential verification
        $('verify-btn').addEventListener('click', handleVerifyCredential);
        $('verify-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleVerifyCredential(); });

        // Import/Export
        $('import-json-btn').addEventListener('click', () => $('import-file-input').click());
        $('import-file-input').addEventListener('change', handleFileImport);
        $('export-btn').addEventListener('click', handleExport);
    }

    // ===== Auth =====

    async function handleLogin() {
        const password = $('login-password').value;
        if (!password) { showToast('请输入密码', 'error'); return; }

        showLoading(true);
        try {
            const response = await fetch(ExamConfig.DATA_PATH + 'bank.enc');
            const encrypted = await response.text();
            const decrypted = await CryptoUtil.decrypt(encrypted.trim(), password);
            bankData = JSON.parse(decrypted);
            adminPassword = password;
            hasUnsavedChanges = false;
            showScreen('dashboard');
            switchTab('questions');
            renderQuestionList();
            showToast('登录成功', 'success');
        } catch (e) {
            showToast('密码错误或数据损坏', 'error');
        } finally {
            showLoading(false);
        }
    }

    async function handleSetup() {
        const pwd1 = $('setup-password').value;
        const pwd2 = $('setup-password-confirm').value;

        if (!pwd1 || pwd1.length < 6) {
            showToast('密码长度至少6位', 'error');
            return;
        }
        if (pwd1 !== pwd2) {
            showToast('两次密码不一致', 'error');
            return;
        }

        adminPassword = pwd1;
        bankData = {
            version: ExamConfig.VERSION,
            credentialSecret: CryptoUtil.generateRandomHex(32),
            salt: CryptoUtil.generateRandomHex(16),
            questions: []
        };

        hasUnsavedChanges = true;
        showScreen('dashboard');
        switchTab('io');
        renderQuestionList();
        showToast('题库已创建！请先导入初始题库，然后导出加密文件', 'success');
    }

    // ===== Tabs =====

    function switchTab(tabName) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === 'tab-' + tabName);
        });
    }

    // ===== Question Management =====

    function renderQuestionList() {
        var questions = bankData.questions;
        $('question-count').textContent = '共 ' + questions.length + ' 题';

        if (questions.length === 0) {
            $('question-list').innerHTML = '<div class="empty-state"><p>题库为空</p><p>请添加题目或在「导入导出」页导入题库 JSON</p></div>';
            return;
        }

        var labels = ['A', 'B', 'C', 'D'];
        var html = '';
        questions.forEach(function(q, index) {
            html += '<div class="question-item">' +
                '<div class="question-item-header">' +
                    '<span class="question-index">#' + (index + 1) + '</span>' +
                    '<span class="question-category-tag">' + escapeHtml(q.category || '未分类') + '</span>' +
                    '<div class="question-actions">' +
                        '<button class="btn-icon" data-action="edit" data-id="' + q.id + '" title="编辑">✏️</button>' +
                        '<button class="btn-icon" data-action="delete" data-id="' + q.id + '" title="删除">🗑️</button>' +
                    '</div>' +
                '</div>' +
                '<div class="question-stem-preview">' + escapeHtml(q.stem) + '</div>' +
                '<div class="question-options-preview">' +
                    q.options.map(function(opt, i) {
                        var cls = i === q.correctIndex ? 'correct-option' : '';
                        return '<span class="' + cls + '">' + labels[i] + '. ' + escapeHtml(opt) + '</span>';
                    }).join('') +
                '</div>' +
            '</div>';
        });

        $('question-list').innerHTML = html;

        // Bind edit/delete buttons via event delegation
        $('question-list').onclick = function(e) {
            var btn = e.target.closest('[data-action]');
            if (!btn) return;
            var action = btn.dataset.action;
            var id = btn.dataset.id;
            if (action === 'edit') editQuestion(id);
            else if (action === 'delete') deleteQuestion(id);
        };
    }

    function showQuestionModal(question) {
        editingQuestionId = question ? question.id : null;
        $('modal-title').textContent = question ? '编辑题目' : '添加题目';
        $('modal-stem').value = question ? question.stem : '';
        $('modal-category').value = question ? (question.category || '新人须知') : '新人须知';

        for (var i = 0; i < 4; i++) {
            $('modal-option-' + i).value = question ? (question.options[i] || '') : '';
        }

        var correctIdx = question ? question.correctIndex : -1;
        document.querySelectorAll('input[name="correct-answer"]').forEach(function(radio) {
            radio.checked = parseInt(radio.value) === correctIdx;
        });

        $('question-modal').classList.add('show');
    }

    function hideQuestionModal() {
        $('question-modal').classList.remove('show');
        editingQuestionId = null;
    }

    function saveQuestion() {
        var stem = $('modal-stem').value.trim();
        var category = $('modal-category').value;
        var options = [0, 1, 2, 3].map(function(i) { return $('modal-option-' + i).value.trim(); });
        var correctRadio = document.querySelector('input[name="correct-answer"]:checked');

        if (!stem) { showToast('请输入题干', 'error'); return; }
        if (options.some(function(opt) { return !opt; })) { showToast('请填写所有选项', 'error'); return; }
        if (!correctRadio) { showToast('请选择正确答案', 'error'); return; }

        var correctIndex = parseInt(correctRadio.value);

        if (editingQuestionId) {
            var idx = bankData.questions.findIndex(function(q) { return q.id === editingQuestionId; });
            if (idx !== -1) {
                bankData.questions[idx].stem = stem;
                bankData.questions[idx].options = options;
                bankData.questions[idx].correctIndex = correctIndex;
                bankData.questions[idx].category = category;
            }
        } else {
            var id = 'q' + String(Date.now()).slice(-8) + String(Math.random()).slice(2, 5);
            bankData.questions.push({
                id: id,
                stem: stem,
                options: options,
                correctIndex: correctIndex,
                category: category
            });
        }

        hasUnsavedChanges = true;
        hideQuestionModal();
        renderQuestionList();
        showToast(editingQuestionId ? '题目已更新' : '题目已添加', 'success');
    }

    function editQuestion(id) {
        var question = bankData.questions.find(function(q) { return q.id === id; });
        if (question) showQuestionModal(question);
    }

    function deleteQuestion(id) {
        if (!confirm('确定要删除这道题目吗？')) return;
        bankData.questions = bankData.questions.filter(function(q) { return q.id !== id; });
        hasUnsavedChanges = true;
        renderQuestionList();
        showToast('题目已删除', 'success');
    }

    // ===== Credential Verification =====

    async function handleVerifyCredential() {
        var code = $('verify-code-input').value.trim();
        if (!code) { showToast('请输入凭证码', 'error'); return; }

        var result = await CryptoUtil.verifyCredential(bankData.questions, code);
        var resultDiv = $('verify-result');

        if (result.valid) {
            var warningHtml = result.warning ? '<p style="color:#f59e0b">⚠️ ' + escapeHtml(result.warning) + '</p>' : '';
            resultDiv.innerHTML =
                '<div class="verify-success">' +
                    '<div class="verify-icon">✅</div>' +
                    '<div class="verify-info">' +
                        '<h3>凭证有效 — 全部答对 (' + result.correctCount + '/' + result.totalCount + ')</h3>' +
                        '<p><strong>玩家 ID:</strong> ' + escapeHtml(result.playerID) + '</p>' +
                        '<p><strong>通过时间:</strong> ' + escapeHtml(result.timeStr) + '</p>' +
                        warningHtml +
                    '</div>' +
                '</div>';
        } else {
            var errorDetail = result.error ? '<p>' + escapeHtml(result.error) + '</p>' : '';
            var warningHtml2 = result.warning ? '<p>' + escapeHtml(result.warning) + '</p>' : '';
            resultDiv.innerHTML =
                '<div class="verify-fail">' +
                    '<div class="verify-icon">❌</div>' +
                    '<div class="verify-info">' +
                        '<h3>凭证无效</h3>' +
                        errorDetail + warningHtml2 +
                        (result.playerID ? '<p><strong>声称的玩家 ID:</strong> ' + escapeHtml(result.playerID) + '</p>' : '') +
                        (result.correctCount !== undefined ? '<p>答对: ' + result.correctCount + '/' + result.totalCount + '</p>' : '') +
                    '</div>' +
                '</div>';
        }
        resultDiv.style.display = 'block';
    }

    // ===== Import / Export =====

    function handleFileImport(e) {
        var file = e.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function(event) {
            try {
                var questions = JSON.parse(event.target.result);
                if (!Array.isArray(questions)) throw new Error('JSON 格式应为数组');

                questions.forEach(function(q, i) {
                    if (!q.stem || !Array.isArray(q.options) || q.options.length !== 4 || typeof q.correctIndex !== 'number') {
                        throw new Error('第 ' + (i + 1) + ' 题格式错误');
                    }
                    if (q.correctIndex < 0 || q.correctIndex > 3) {
                        throw new Error('第 ' + (i + 1) + ' 题 correctIndex 应为 0-3');
                    }
                    if (!q.id) q.id = 'q' + String(Date.now()).slice(-6) + String(i).padStart(3, '0');
                    if (!q.category) q.category = '未分类';
                });

                var action = 'replace';
                if (bankData.questions.length > 0) {
                    action = confirm('当前题库已有 ' + bankData.questions.length + ' 题。\n\n确定 → 追加导入\n取消 → 替换全部')
                        ? 'append' : 'replace';
                }

                if (action === 'replace') {
                    bankData.questions = questions;
                } else {
                    bankData.questions = bankData.questions.concat(questions);
                }

                hasUnsavedChanges = true;
                renderQuestionList();
                showToast('成功导入 ' + questions.length + ' 道题目', 'success');
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }

    async function handleExport() {
        if (!bankData || bankData.questions.length === 0) {
            showToast('题库为空，请先添加题目', 'error');
            return;
        }
        if (bankData.questions.length < ExamConfig.QUESTIONS_PER_EXAM) {
            showToast('题库至少需要 ' + ExamConfig.QUESTIONS_PER_EXAM + ' 题（当前 ' + bankData.questions.length + ' 题）', 'error');
            return;
        }

        showLoading(true);
        try {
            // Generate exam data with answer hashes
            var examQuestions = [];
            for (var i = 0; i < bankData.questions.length; i++) {
                var q = bankData.questions[i];
                var answerHash = await CryptoUtil.hashAnswer(bankData.salt, q.id, q.correctIndex);
                examQuestions.push({
                    id: q.id,
                    stem: q.stem,
                    options: q.options,
                    category: q.category,
                    answerHash: answerHash
                });
            }

            var examData = {
                version: bankData.version,
                salt: bankData.salt,
                questions: examQuestions
            };

            // Encrypt exam data with site key
            var examEncrypted = await CryptoUtil.encrypt(JSON.stringify(examData), ExamConfig.getSiteKey());

            // Encrypt bank data with admin password
            var bankEncrypted = await CryptoUtil.encrypt(JSON.stringify(bankData), adminPassword);

            // Download both files
            downloadFile('exam.enc', examEncrypted);
            setTimeout(function() {
                downloadFile('bank.enc', bankEncrypted);
            }, 600);

            hasUnsavedChanges = false;
            showToast('加密文件已导出！请将文件放入 data/ 目录并部署', 'success');
        } catch (e) {
            showToast('导出失败: ' + e.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    function downloadFile(filename, content) {
        var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ===== Utilities =====

    function showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
        $(screenId).classList.add('active');
    }

    function showToast(msg, type) {
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(function() { toast.classList.add('show'); }, 10);
        setTimeout(function() {
            toast.classList.remove('show');
            setTimeout(function() { toast.remove(); }, 300);
        }, 3000);
    }

    function showLoading(show) {
        $('loading-overlay').style.display = show ? 'flex' : 'none';
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', function() { AdminApp.init(); });
