/**
 * 管理面板逻辑
 */
const AdminApp = (() => {
    let bankData = null;
    let adminPassword = '';
    let isNewSetup = false;
    let editingQuestionId = null;
    let hasUnsavedChanges = false;
    let syncMode = false; // 是否通过 Worker 同步
    let remoteBankSha = null; // 乐观锁：上次读取时的 bank.enc SHA

    const $ = id => document.getElementById(id);

    async function init() {
        bindEvents();

        // 更新同步状态显示
        updateSyncStatusUI();

        // Try to load existing bank — 优先从 Worker，回退到本地
        let bankExists = false;
        if (GitHubSync.isConfigured()) {
            try {
                const result = await GitHubSync.readFile('data/bank.enc');
                if (result.exists) {
                    bankExists = true;
                    syncMode = true;
                }
            } catch (e) {
                // Worker 连接失败，回退到本地
                console.warn('Worker 连接失败，回退本地模式:', e.message);
            }
        }

        if (!bankExists) {
            try {
                const response = await fetch(ExamConfig.DATA_PATH + 'bank.enc');
                if (response.ok) bankExists = true;
            } catch (e) { /* ignore */ }
        }

        if (bankExists) {
            isNewSetup = false;
            showScreen('login-screen');
        } else {
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

        // Sync config
        $('sync-save-btn').addEventListener('click', handleSyncSave);
        $('sync-test-btn').addEventListener('click', handleSyncTest);
        $('sync-clear-btn').addEventListener('click', handleSyncClear);

        // Settings
        var settingsInput = $('settings-questions-per-exam');
        if (settingsInput) {
            settingsInput.addEventListener('change', handleSettingsChange);
            settingsInput.addEventListener('blur', handleSettingsChange);
        }
        var notifyUrlInput = $('settings-notify-url');
        if (notifyUrlInput) {
            notifyUrlInput.addEventListener('change', handleNotifyUrlChange);
            notifyUrlInput.addEventListener('blur', handleNotifyUrlChange);
        }

        // Quick sync button
        var quickSyncBtn = $('quick-sync-btn');
        if (quickSyncBtn) {
            quickSyncBtn.addEventListener('click', handleQuickSync);
        }
    }

    // ===== Auth =====

    async function handleLogin() {
        const password = $('login-password').value;
        if (!password) { showToast('请输入密码', 'error'); return; }

        showLoading(true);
        try {
            let encrypted;
            // 优先从 Worker 读取
            if (GitHubSync.isConfigured()) {
                try {
                    const result = await GitHubSync.readFile('data/bank.enc');
                    if (result.exists) {
                        encrypted = result.content;
                        remoteBankSha = result.sha;
                        syncMode = true;
                    }
                } catch (e) {
                    console.warn('Worker 读取失败，回退本地:', e.message);
                }
            }
            // 回退到本地
            if (!encrypted) {
                const response = await fetch(ExamConfig.DATA_PATH + 'bank.enc');
                encrypted = await response.text();
                syncMode = false;
            }

            const decrypted = await CryptoUtil.decrypt(encrypted.trim(), password);
            bankData = JSON.parse(decrypted);
            // 向后兼容：老数据没有 settings
            if (!bankData.settings) {
                bankData.settings = { questionsPerExam: 15 };
            }
            adminPassword = password;
            hasUnsavedChanges = false;
            showScreen('dashboard');
            switchTab('questions');
            renderQuestionList();
            initDragDrop();
            updateSyncStatusUI();
            updateSettingsUI();
            checkDraftRecovery();
            showToast('登录成功' + (syncMode ? '（云端同步模式）' : '（本地模式）'), 'success');
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
            settings: {
                questionsPerExam: 15  // 默认15题，0表示全部
            },
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
        updateSyncWarningUI();
        updateSettingsUI();

        if (questions.length === 0) {
            $('question-list').innerHTML = '<div class="empty-state"><p>题库为空</p><p>请添加题目或在「导入导出」页导入题库 JSON</p></div>';
            return;
        }

        var labels = ['A', 'B', 'C', 'D'];
        var html = '';
        questions.forEach(function(q, index) {
            html += '<div class="question-item" draggable="true" data-id="' + q.id + '" data-index="' + index + '">' +
                '<div class="question-item-header">' +
                    '<span class="drag-handle" title="拖拽排序">☰</span>' +
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
        if (stem.length > 500) { showToast('题干过长（最多500字）', 'error'); return; }
        if (options.some(function(opt) { return !opt; })) { showToast('请填写所有选项', 'error'); return; }
        if (options.some(function(opt) { return opt.length > 200; })) { showToast('选项过长（最多200字）', 'error'); return; }
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
        initDragDrop();
        scheduleDraftSave();
        showToast(editingQuestionId ? '题目已更新' : '题目已添加', 'success');
    }

    function editQuestion(id) {
        var question = bankData.questions.find(function(q) { return q.id === id; });
        if (question) showQuestionModal(question);
    }

    function deleteQuestion(id) {
        var remaining = bankData.questions.length - 1;
        if (remaining < 5) {
            if (!confirm('⚠️ 删除后仅剩 ' + remaining + ' 道题！题目过少会影响考试质量。确定要删除吗？')) return;
        } else {
            if (!confirm('确定要删除这道题目吗？')) return;
        }
        bankData.questions = bankData.questions.filter(function(q) { return q.id !== id; });
        hasUnsavedChanges = true;
        renderQuestionList();
        initDragDrop();
        scheduleDraftSave();
        showToast('题目已删除（剩余 ' + bankData.questions.length + ' 道）', 'success');
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
                    if (!q.stem || typeof q.stem !== 'string') {
                        throw new Error('第 ' + (i + 1) + ' 题缺少题干或格式错误');
                    }
                    if (!Array.isArray(q.options) || q.options.length !== 4) {
                        throw new Error('第 ' + (i + 1) + ' 题必须有 4 个选项');
                    }
                    if (q.options.some(function(o) { return typeof o !== 'string' || !o.trim(); })) {
                        throw new Error('第 ' + (i + 1) + ' 题选项不能为空或非字符串');
                    }
                    if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex > 3) {
                        throw new Error('第 ' + (i + 1) + ' 题 correctIndex 应为 0-3 的数字');
                    }
                    if (q.stem.length > 500) throw new Error('第 ' + (i + 1) + ' 题题干过长（最多500字）');
                    if (q.options.some(function(o) { return o.length > 200; })) {
                        throw new Error('第 ' + (i + 1) + ' 题选项过长（最多200字）');
                    }
                    // 清洗字段：只保留必要属性
                    q.stem = q.stem.trim();
                    q.options = q.options.map(function(o) { return o.trim(); });
                    q.correctIndex = Math.floor(q.correctIndex);
                    if (!q.id || typeof q.id !== 'string') q.id = 'q' + String(Date.now()).slice(-6) + String(i).padStart(3, '0');
                    q.id = q.id.trim().substring(0, 50);
                    q.category = (typeof q.category === 'string' && q.category.trim()) ? q.category.trim().substring(0, 30) : '未分类';
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
                initDragDrop();
                scheduleDraftSave();
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
                settings: bankData.settings || { questionsPerExam: 15 },
                questions: examQuestions
            };

            // Encrypt
            var examEncrypted = await CryptoUtil.encrypt(JSON.stringify(examData), ExamConfig.getSiteKey());
            var bankEncrypted = await CryptoUtil.encrypt(JSON.stringify(bankData), adminPassword);

            // 如果配置了 Worker，直接推送到 GitHub（带乐观锁）
            if (GitHubSync.isConfigured()) {
                try {
                    // bank.enc 带 SHA 乐观锁，exam.enc 无锁（派生文件）
                    var writeResult = await GitHubSync.writeFiles([
                        { path: 'data/bank.enc', content: bankEncrypted, sha: remoteBankSha },
                        { path: 'data/exam.enc', content: examEncrypted }
                    ], '更新考试题库', bankData.questions.length);
                    // 写入成功，更新本地 SHA
                    if (writeResult.files) {
                        writeResult.files.forEach(function(f) {
                            if (f.path === 'data/bank.enc') remoteBankSha = f.sha;
                        });
                    }
                    hasUnsavedChanges = false;
                    syncMode = true;
                    clearDraft();
                    updateSyncWarningUI();
                    showToast('已推送到 GitHub！Pages 将在1-2分钟后更新', 'success');
                    return;
                } catch (e) {
                    if (e.conflict) {
                        // 乐观锁冲突：另一位管理员在期间修改了题库
                        await handleConflict(e.conflictData);
                        return;
                    }
                    // Worker 推送失败，回退到本地下载
                    showToast('云端推送失败: ' + e.message + '，回退到本地下载', 'error');
                }
            }

            // 本地下载模式
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

    // ===== Sync Config =====

    function updateSyncStatusUI() {
        var badge = $('sync-status-badge');
        var info = $('sync-current-info');
        if (!badge || !info) return;

        if (GitHubSync.isConfigured()) {
            var cfg = GitHubSync.getConfig();
            badge.textContent = '已配置';
            badge.className = 'sync-badge connected';
            info.innerHTML = '<p>✅ Worker 地址: <code>' + escapeHtml(cfg.workerUrl) + '</code></p>';
            $('sync-worker-url').value = cfg.workerUrl;
            $('sync-admin-secret').value = cfg.adminSecret;
        } else {
            badge.textContent = '未配置';
            badge.className = 'sync-badge disconnected';
            info.innerHTML = '<p>未配置云端同步，导出时将下载本地文件</p>';
        }
    }

    function handleSyncSave() {
        var workerUrl = $('sync-worker-url').value.trim();
        var adminSecret = $('sync-admin-secret').value.trim();

        if (!workerUrl) { showToast('请输入 Worker 地址', 'error'); return; }
        if (!adminSecret) { showToast('请输入管理员通信密钥', 'error'); return; }

        // 基本URL格式校验
        try { new URL(workerUrl); } catch {
            showToast('Worker 地址格式不正确', 'error'); return;
        }

        GitHubSync.saveConfig(workerUrl, adminSecret);
        updateSyncStatusUI();
        showToast('同步配置已保存', 'success');
    }

    async function handleSyncTest() {
        if (!GitHubSync.isConfigured()) {
            showToast('请先保存配置', 'error');
            return;
        }
        showLoading(true);
        try {
            var result = await GitHubSync.testConnection();
            var msg = '连接成功！仓库: ' + result.repo;
            if (!result.canPush) {
                showToast(msg + '（⚠️ 无写入权限，请检查 PAT）', 'error');
            } else {
                showToast(msg + '（有写入权限 ✓）', 'success');
            }
        } catch (e) {
            showToast('连接失败: ' + e.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    function handleSyncClear() {
        if (!confirm('确定清除同步配置？之后导出操作将回退到本地下载模式。')) return;
        GitHubSync.clearConfig();
        syncMode = false;
        $('sync-worker-url').value = '';
        $('sync-admin-secret').value = '';
        updateSyncStatusUI();
        showToast('同步配置已清除', 'success');
    }

    // ===== Settings UI =====

    function updateSettingsUI() {
        var input = $('settings-questions-per-exam');
        if (!input || !bankData) return;
        var val = (bankData.settings && bankData.settings.questionsPerExam) || 15;
        input.value = val;
        // 更新提示
        var hint = $('settings-questions-hint');
        if (hint) {
            if (val <= 0 || val >= bankData.questions.length) {
                hint.textContent = '当前设置：答全部 ' + bankData.questions.length + ' 题';
            } else {
                hint.textContent = '当前设置：从 ' + bankData.questions.length + ' 题中随机抽 ' + val + ' 题';
            }
        }
        var notifyInput = $('settings-notify-url');
        if (notifyInput) {
            notifyInput.value = (bankData.settings && bankData.settings.notifyWorkerUrl) || '';
        }
    }

    function handleSettingsChange() {
        var input = $('settings-questions-per-exam');
        if (!input || !bankData) return;
        var val = parseInt(input.value) || 0;
        if (val < 0) val = 0;
        if (val > 999) val = 999;
        input.value = val;
        if (!bankData.settings) bankData.settings = {};
        bankData.settings.questionsPerExam = val;
        hasUnsavedChanges = true;
        updateSettingsUI();
        updateSyncWarningUI();
        scheduleDraftSave();
        showToast('答题数量已更新，请同步以生效', 'success');
    }

    function handleNotifyUrlChange() {
        var input = $('settings-notify-url');
        if (!input || !bankData) return;
        var val = input.value.trim().replace(/\/+$/, '');
        if (val) {
            try { new URL(val); } catch {
                showToast('通知 Worker 地址格式不正确', 'error');
                return;
            }
        }
        if (!bankData.settings) bankData.settings = {};
        bankData.settings.notifyWorkerUrl = val || null;
        hasUnsavedChanges = true;
        updateSyncWarningUI();
        scheduleDraftSave();
        showToast('通知地址已更新，请同步以生效', 'success');
    }

    // ===== Sync Warning & Quick Sync =====

    function updateSyncWarningUI() {
        var bar = $('sync-warning-bar');
        var btn = $('quick-sync-btn');
        if (!bar || !btn) return;

        if (hasUnsavedChanges) {
            bar.style.display = 'flex';
            btn.disabled = false;
        } else {
            bar.style.display = 'none';
            btn.disabled = true;
        }
    }

    async function handleQuickSync() {
        await handleExport();
        updateSyncWarningUI();
    }

    // ===== Draft (localStorage) =====

    var DRAFT_KEY = 'exam_bank_draft';
    var draftTimer = null;

    function scheduleDraftSave() {
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(saveDraft, 3000);
    }

    function saveDraft() {
        if (!bankData) return;
        try {
            var draft = {
                timestamp: Date.now(),
                data: bankData
            };
            localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        } catch (e) {
            console.warn('保存草稿失败:', e);
        }
    }

    function clearDraft() {
        try {
            localStorage.removeItem(DRAFT_KEY);
        } catch (e) { /* ignore */ }
    }

    function checkDraftRecovery() {
        try {
            var raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return;
            var draft = JSON.parse(raw);
            if (!draft || !draft.data || !draft.timestamp) return;
            // 如果草稿比当前数据新，提示恢复
            var draftTime = new Date(draft.timestamp);
            var timeStr = draftTime.toLocaleString('zh-CN');
            if (confirm('发现本地草稿（' + timeStr + '），是否恢复？\n\n选择「确定」恢复草稿内容\n选择「取消」使用云端数据并删除草稿')) {
                bankData = draft.data;
                hasUnsavedChanges = true;
                renderQuestionList();
                updateSettingsUI();
                showToast('已恢复本地草稿', 'success');
            } else {
                clearDraft();
            }
        } catch (e) {
            console.warn('读取草稿失败:', e);
            clearDraft();
        }
    }

    // ===== 冲突处理（乐观锁） =====

    async function handleConflict(conflictData) {
        // 自动保存草稿，防止丢失
        saveDraft();
        showLoading(false);

        try {
            // 解密远程版本的 bank.enc
            var remoteDecrypted = await CryptoUtil.decrypt(conflictData.currentContent.trim(), adminPassword);
            var remoteBankData = JSON.parse(remoteDecrypted);

            // 计算差异
            var diff = diffQuestionBanks(bankData.questions, remoteBankData.questions);

            // 显示冲突对话框
            showConflictModal(diff, remoteBankData, conflictData.currentSha);
        } catch (e) {
            showToast('冲突解析失败: ' + e.message + '。本地修改已保存为草稿，请刷新后重试', 'error');
        }
    }

    function diffQuestionBanks(localQuestions, remoteQuestions) {
        var localMap = {};
        localQuestions.forEach(function(q) { localMap[q.id] = q; });
        var remoteMap = {};
        remoteQuestions.forEach(function(q) { remoteMap[q.id] = q; });

        var localOnly = [];  // 本地新增
        var remoteOnly = []; // 对方新增
        var modified = [];   // 双方都修改
        var unchanged = 0;

        localQuestions.forEach(function(q) {
            if (!remoteMap[q.id]) {
                localOnly.push(q);
            } else if (q.stem !== remoteMap[q.id].stem ||
                       q.correctIndex !== remoteMap[q.id].correctIndex ||
                       JSON.stringify(q.options) !== JSON.stringify(remoteMap[q.id].options)) {
                modified.push({ local: q, remote: remoteMap[q.id] });
            } else {
                unchanged++;
            }
        });

        remoteQuestions.forEach(function(q) {
            if (!localMap[q.id]) {
                remoteOnly.push(q);
            }
        });

        return { localOnly: localOnly, remoteOnly: remoteOnly, modified: modified, unchanged: unchanged };
    }

    function showConflictModal(diff, remoteBankData, remoteSha) {
        var html = '<div class="conflict-modal-content">';
        html += '<h2>\u26a0\ufe0f \u540c\u6b65\u51b2\u7a81</h2>';
        html += '<p>\u53e6\u4e00\u4f4d\u7ba1\u7406\u5458\u5728\u4f60\u7f16\u8f91\u671f\u95f4\u66f4\u65b0\u4e86\u9898\u5e93\uff0c\u9700\u8981\u5904\u7406\u51b2\u7a81\u3002</p>';

        html += '<div class="conflict-summary">';
        html += '<div class="conflict-side"><strong>\ud83d\udcbb \u672c\u5730\u7248\u672c</strong><span>' + bankData.questions.length + ' \u9898</span></div>';
        html += '<div class="conflict-vs">VS</div>';
        html += '<div class="conflict-side"><strong>\u2601\ufe0f \u4e91\u7aef\u7248\u672c</strong><span>' + remoteBankData.questions.length + ' \u9898</span></div>';
        html += '</div>';

        // 差异明细
        if (diff.localOnly.length > 0) {
            html += '<div class="diff-section diff-added">';
            html += '<h3>\ud83d\udcdd \u4f60\u65b0\u589e\u7684\u9898\u76ee (' + diff.localOnly.length + ')</h3>';
            diff.localOnly.forEach(function(q) {
                html += '<div class="diff-item">' + escapeHtml(q.stem.substring(0, 80)) + (q.stem.length > 80 ? '...' : '') + '</div>';
            });
            html += '</div>';
        }
        if (diff.remoteOnly.length > 0) {
            html += '<div class="diff-section diff-remote">';
            html += '<h3>\ud83d\udce5 \u5bf9\u65b9\u65b0\u589e\u7684\u9898\u76ee (' + diff.remoteOnly.length + ')</h3>';
            diff.remoteOnly.forEach(function(q) {
                html += '<div class="diff-item">' + escapeHtml(q.stem.substring(0, 80)) + (q.stem.length > 80 ? '...' : '') + '</div>';
            });
            html += '</div>';
        }
        if (diff.modified.length > 0) {
            html += '<div class="diff-section diff-modified">';
            html += '<h3>\u270f\ufe0f \u53cc\u65b9\u90fd\u4fee\u6539\u4e86 (' + diff.modified.length + ')</h3>';
            diff.modified.forEach(function(m) {
                html += '<div class="diff-item"><span class="diff-label-local">\u672c\u5730:</span> ' + escapeHtml(m.local.stem.substring(0, 60)) + (m.local.stem.length > 60 ? '...' : '') + '</div>';
                html += '<div class="diff-item"><span class="diff-label-remote">\u4e91\u7aef:</span> ' + escapeHtml(m.remote.stem.substring(0, 60)) + (m.remote.stem.length > 60 ? '...' : '') + '</div>';
            });
            html += '</div>';
        }
        html += '<p class="diff-unchanged">\u2705 \u4e00\u81f4\u9898\u76ee: ' + diff.unchanged + ' \u9053</p>';

        // 操作按钮
        html += '<div class="conflict-actions">';
        html += '<button class="btn btn-primary" id="conflict-merge-btn" title="\u5408\u5e76\u4e24\u4e2a\u7248\u672c\uff1a\u4fdd\u7559\u6240\u6709\u9898\u76ee\uff0c\u51b2\u7a81\u9898\u76ee\u4f7f\u7528\u672c\u5730\u7248\u672c">\ud83d\udd00 \u667a\u80fd\u5408\u5e76</button>';
        html += '<button class="btn btn-danger" id="conflict-force-btn">\ud83d\udd28 \u5f3a\u5236\u8986\u76d6\u4e91\u7aef</button>';
        html += '<button class="btn btn-secondary" id="conflict-load-remote-btn">\ud83d\udce5 \u4f7f\u7528\u4e91\u7aef\u7248\u672c</button>';
        html += '</div>';
        html += '<p class="conflict-hint">\ud83d\udca1 \u672c\u5730\u4fee\u6539\u5df2\u81ea\u52a8\u4fdd\u5b58\u4e3a\u8349\u7a3f\uff0c\u4e0d\u4f1a\u4e22\u5931</p>';
        html += '</div>';

        var modal = document.createElement('div');
        modal.className = 'modal show';
        modal.id = 'conflict-modal';
        modal.innerHTML = html;
        document.body.appendChild(modal);

        // 点击背景关闭
        modal.addEventListener('click', function(e) {
            if (e.target === modal) closeConflictModal();
        });

        document.getElementById('conflict-merge-btn').onclick = function() {
            closeConflictModal();
            mergeVersions(remoteBankData, remoteSha);
        };
        document.getElementById('conflict-force-btn').onclick = function() {
            closeConflictModal();
            forceOverwrite();
        };
        document.getElementById('conflict-load-remote-btn').onclick = function() {
            closeConflictModal();
            loadRemoteVersion(remoteBankData, remoteSha);
        };
    }

    function closeConflictModal() {
        var modal = document.getElementById('conflict-modal');
        if (modal) modal.remove();
    }

    async function forceOverwrite() {
        // 清除 SHA → Worker 将获取最新 SHA → 强制覆盖
        remoteBankSha = null;
        showToast('\u6b63\u5728\u5f3a\u5236\u8986\u76d6...', 'success');
        await handleExport();
    }

    function loadRemoteVersion(remoteBankData, remoteSha) {
        bankData = remoteBankData;
        if (!bankData.settings) bankData.settings = { questionsPerExam: 15 };
        remoteBankSha = remoteSha;
        hasUnsavedChanges = false;
        clearDraft();
        renderQuestionList();
        initDragDrop();
        updateSettingsUI();
        updateSyncWarningUI();
        showToast('\u5df2\u52a0\u8f7d\u4e91\u7aef\u7248\u672c', 'success');
    }

    function mergeVersions(remoteBankData, remoteSha) {
        var localMap = {};
        bankData.questions.forEach(function(q) { localMap[q.id] = q; });

        // 以\u672c\u5730\u4e3a\u57fa\u7840\uff0c\u8ffd\u52a0\u5bf9\u65b9\u65b0\u589e\u7684\u9898\u76ee
        var merged = bankData.questions.slice();
        var addedCount = 0;
        remoteBankData.questions.forEach(function(q) {
            if (!localMap[q.id]) {
                merged.push(q);
                addedCount++;
            }
        });

        bankData.questions = merged;
        // \u5408\u5e76 settings\uff1a\u4f18\u5148\u672c\u5730
        remoteBankSha = remoteSha;
        hasUnsavedChanges = true;
        renderQuestionList();
        initDragDrop();
        updateSettingsUI();
        updateSyncWarningUI();
        showToast('\u5df2\u5408\u5e76\uff08\u5171 ' + merged.length + ' \u9898\uff0c\u65b0\u589e ' + addedCount + ' \u9898\uff09\uff0c\u8bf7\u68c0\u67e5\u540e\u540c\u6b65', 'success');
    }

    // ===== Drag & Drop =====

    var draggedItem = null;

    function initDragDrop() {
        var list = $('question-list');
        if (!list) return;

        list.addEventListener('dragstart', function(e) {
            var item = e.target.closest('.question-item');
            if (!item) return;
            draggedItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.dataset.index);
        });

        list.addEventListener('dragend', function(e) {
            var item = e.target.closest('.question-item');
            if (item) item.classList.remove('dragging');
            draggedItem = null;
            // 移除所有 drop 指示
            list.querySelectorAll('.question-item').forEach(function(el) {
                el.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
            });
        });

        list.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            var item = e.target.closest('.question-item');
            if (!item || item === draggedItem) return;
            // 判断插入上方还是下方
            var rect = item.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            list.querySelectorAll('.question-item').forEach(function(el) {
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            });
            if (e.clientY < midY) {
                item.classList.add('drag-over-top');
            } else {
                item.classList.add('drag-over-bottom');
            }
        });

        list.addEventListener('dragleave', function(e) {
            var item = e.target.closest('.question-item');
            if (item) {
                item.classList.remove('drag-over-top', 'drag-over-bottom');
            }
        });

        list.addEventListener('drop', function(e) {
            e.preventDefault();
            var targetItem = e.target.closest('.question-item');
            if (!targetItem || !draggedItem || targetItem === draggedItem) return;

            var fromIndex = parseInt(draggedItem.dataset.index);
            var toIndex = parseInt(targetItem.dataset.index);
            // 判断上半还是下半
            var rect = targetItem.getBoundingClientRect();
            var insertAfter = e.clientY >= rect.top + rect.height / 2;
            if (insertAfter && toIndex < fromIndex) toIndex++;
            else if (!insertAfter && toIndex > fromIndex) toIndex--;

            // 执行数组移动
            var questions = bankData.questions;
            var moved = questions.splice(fromIndex, 1)[0];
            questions.splice(toIndex, 0, moved);

            hasUnsavedChanges = true;
            renderQuestionList();
            initDragDrop();
            scheduleDraftSave();
            showToast('题目顺序已调整', 'success');
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', function() { AdminApp.init(); });
