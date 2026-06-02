import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync('js/bank-model.js', 'utf8') + '\nglobalThis.BankModel = BankModel;';
const context = { console, Date, Number, String, Array, Math, Error };
vm.createContext(context);
vm.runInContext(source, context);

const { BankModel } = context;

function makeBank(questionCount, questionsPerExam) {
  return {
    version: 1,
    salt: 'salt',
    settings: { questionsPerExam },
    questions: Array.from({ length: questionCount }, (_, i) => ({
      id: 'q' + String(i + 1).padStart(3, '0'),
      stem: '题目 ' + (i + 1),
      options: ['A', 'B', 'C', 'D'],
      correctIndex: 0,
      category: '测试'
    }))
  };
}

{
  const bank = makeBank(30, 30);
  bank.questions.push({ id: 'q031', stem: '新增题', options: ['A', 'B', 'C', 'D'], correctIndex: 2, category: '测试' });
  const next = BankModel.afterQuestionCountChanged(bank, 30);
  assert.equal(next, 31);
  assert.equal(bank.settings.questionsPerExam, 31);
}

{
  const bank = makeBank(30, 15);
  bank.questions.push({ id: 'q031', stem: '新增题', options: ['A', 'B', 'C', 'D'], correctIndex: 2, category: '测试' });
  const next = BankModel.afterQuestionCountChanged(bank, 30);
  assert.equal(next, 15);
}

{
  const bank = makeBank(31, 0);
  assert.equal(BankModel.getQuestionsPerExam(bank), 31);
  assert.equal(BankModel.setQuestionsPerExam(bank, 999), 31);
}

{
  const normalized = BankModel.normalizeQuestions([{ stem: '  S  ', options: [' A ', 'B', 'C', 'D'], correctIndex: 2 }]);
  assert.equal(normalized[0].stem, 'S');
  assert.deepEqual(normalized[0].options, ['A', 'B', 'C', 'D']);
  assert.equal(normalized[0].correctIndex, 2);
}

console.log('BankModel tests passed');
