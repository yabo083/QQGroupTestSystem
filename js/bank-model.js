/**
 * 管理端题库数据模型：只处理纯数据，不直接操作 DOM 或网络。
 */
const BankModel = (() => {
    const DEFAULT_CATEGORY = '未分类';

    function ensureSettings(bankData) {
        if (!bankData.settings) bankData.settings = {};
        if (typeof bankData.settings.questionsPerExam !== 'number') {
            bankData.settings.questionsPerExam = getQuestionCount(bankData);
        }
        return bankData.settings;
    }

    function getQuestionCount(bankData) {
        return bankData && Array.isArray(bankData.questions) ? bankData.questions.length : 0;
    }

    function getQuestionsPerExam(bankData) {
        const settings = ensureSettings(bankData);
        const count = getQuestionCount(bankData);
        const value = Math.floor(Number(settings.questionsPerExam));
        if (!Number.isFinite(value) || value <= 0 || value >= count) return count;
        return value;
    }

    function setQuestionsPerExam(bankData, rawValue) {
        const settings = ensureSettings(bankData);
        const count = getQuestionCount(bankData);
        let value = Math.floor(Number(rawValue));
        if (!Number.isFinite(value) || value < 0) value = 0;
        if (value <= 0 || value >= count) value = count;
        settings.questionsPerExam = value;
        return value;
    }

    function shouldAutoExpandQuestionCount(bankData) {
        const count = getQuestionCount(bankData);
        const settings = ensureSettings(bankData);
        const value = Number(settings.questionsPerExam);
        return !Number.isFinite(value) || value <= 0 || value >= count;
    }

    function afterQuestionCountChanged(bankData, previousCount) {
        const settings = ensureSettings(bankData);
        const count = getQuestionCount(bankData);
        const value = Number(settings.questionsPerExam);
        if (!Number.isFinite(value) || value <= 0 || value >= previousCount) {
            settings.questionsPerExam = count;
        } else if (value > count) {
            settings.questionsPerExam = count;
        }
        return settings.questionsPerExam;
    }

    function normalizeQuestion(question, index) {
        if (!question || typeof question !== 'object') {
            throw new Error('第 ' + (index + 1) + ' 题格式错误');
        }
        if (!question.stem || typeof question.stem !== 'string') {
            throw new Error('第 ' + (index + 1) + ' 题缺少题干或格式错误');
        }
        if (!Array.isArray(question.options) || question.options.length !== 4) {
            throw new Error('第 ' + (index + 1) + ' 题必须有 4 个选项');
        }
        if (question.options.some(function(option) { return typeof option !== 'string' || !option.trim(); })) {
            throw new Error('第 ' + (index + 1) + ' 题选项不能为空或非字符串');
        }
        if (typeof question.correctIndex !== 'number' || question.correctIndex < 0 || question.correctIndex > 3) {
            throw new Error('第 ' + (index + 1) + ' 题 correctIndex 应为 0-3 的数字');
        }
        if (question.stem.length > 500) throw new Error('第 ' + (index + 1) + ' 题题干过长（最多500字）');
        if (question.options.some(function(option) { return option.length > 200; })) {
            throw new Error('第 ' + (index + 1) + ' 题选项过长（最多200字）');
        }

        return {
            id: (typeof question.id === 'string' && question.id.trim())
                ? question.id.trim().substring(0, 50)
                : 'q' + String(Date.now()).slice(-6) + String(index).padStart(3, '0'),
            stem: question.stem.trim(),
            options: question.options.map(function(option) { return option.trim(); }),
            correctIndex: Math.floor(question.correctIndex),
            category: (typeof question.category === 'string' && question.category.trim())
                ? question.category.trim().substring(0, 30)
                : DEFAULT_CATEGORY
        };
    }

    function normalizeQuestions(questions) {
        if (!Array.isArray(questions)) throw new Error('JSON 格式应为数组');
        return questions.map(normalizeQuestion);
    }

    async function buildExamData(bankData, hashAnswer) {
        ensureSettings(bankData);
        const examQuestions = [];
        for (let i = 0; i < bankData.questions.length; i++) {
            const question = bankData.questions[i];
            examQuestions.push({
                id: question.id,
                stem: question.stem,
                options: question.options,
                category: question.category,
                answerHash: await hashAnswer(bankData.salt, question.id, question.correctIndex)
            });
        }
        return {
            version: bankData.version,
            salt: bankData.salt,
            settings: bankData.settings,
            questions: examQuestions
        };
    }

    return {
        ensureSettings,
        getQuestionCount,
        getQuestionsPerExam,
        setQuestionsPerExam,
        shouldAutoExpandQuestionCount,
        afterQuestionCountChanged,
        normalizeQuestion,
        normalizeQuestions,
        buildExamData
    };
})();
