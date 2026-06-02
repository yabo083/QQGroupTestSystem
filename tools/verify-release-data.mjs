import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const crypto = webcrypto;
const PBKDF2_ITERATIONS = 100000;
const ANSWER_HASH_ITERATIONS = 50000;
const siteKeyObfuscated = [31, 34, 59, 55, 9, 35, 41, 104, 106, 104, 108, 123, 9, 63, 57, 47, 40, 63, 17, 105, 35, 121, 10, 54, 59, 46, 60, 53, 40, 55];
const siteKey = String.fromCharCode(...siteKeyObfuscated.map(c => c ^ 0x5A));

const bankPath = process.argv[2] || 'data/bank.enc';
const examPath = process.argv[3] || 'data/exam.enc';
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminPassword) {
  fail('ADMIN_PASSWORD environment variable is required to verify bank.enc');
}

function fail(message) {
  console.error('[verify-release-data] ' + message);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function base64ToBytes(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function encryptedParts(encrypted, label) {
  const parts = encrypted.trim().split('.');
  assert(parts.length === 3, label + ' must use salt.iv.ciphertext format');
  const [salt, iv, ciphertext] = parts.map(base64ToBytes);
  assert(salt.byteLength === 16, label + ' salt must be 16 bytes');
  assert(iv.byteLength === 12, label + ' iv must be 12 bytes');
  assert(ciphertext.byteLength > 16, label + ' ciphertext is too short');
  return { salt, iv, ciphertext };
}

async function deriveKey(password, salt, usages) {
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
    usages
  );
}

async function decryptJson(filePath, password, label) {
  const encrypted = readFileSync(filePath, 'utf8');
  const { salt, iv, ciphertext } = encryptedParts(encrypted, label);
  const key = await deriveKey(password, salt, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function hex(bytes) {
  return Buffer.from(new Uint8Array(bytes)).toString('hex');
}

async function hashAnswer(salt, questionId, optionIndex) {
  const input = salt + ':' + questionId + ':' + optionIndex;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(input), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt + questionId), iterations: ANSWER_HASH_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return hex(bits);
}

function validateQuestion(question, index, source) {
  assert(question && typeof question === 'object', source + ' question #' + (index + 1) + ' must be an object');
  assert(typeof question.id === 'string' && question.id.trim(), source + ' question #' + (index + 1) + ' missing id');
  assert(typeof question.stem === 'string' && question.stem.trim(), source + ' question ' + question.id + ' missing stem');
  assert(Array.isArray(question.options) && question.options.length === 4, source + ' question ' + question.id + ' must have 4 options');
  question.options.forEach((option, optionIndex) => {
    assert(typeof option === 'string' && option.trim(), source + ' question ' + question.id + ' option ' + optionIndex + ' is empty');
  });
}

async function main() {
  const bank = await decryptJson(bankPath, adminPassword, 'bank.enc');
  const exam = await decryptJson(examPath, siteKey, 'exam.enc');

  assert(Array.isArray(bank.questions), 'bank.questions must be an array');
  assert(Array.isArray(exam.questions), 'exam.questions must be an array');
  assert(bank.questions.length > 0, 'question bank must not be empty');
  assert(bank.questions.length === exam.questions.length, 'bank/exam question counts differ');
  assert(bank.version === exam.version, 'bank/exam versions differ');
  assert(bank.salt === exam.salt, 'bank/exam salts differ');

  const bankSettings = bank.settings || {};
  const examSettings = exam.settings || {};
  const bankQuestionsPerExam = Number(bankSettings.questionsPerExam ?? 15);
  const examQuestionsPerExam = Number(examSettings.questionsPerExam ?? 15);
  assert(bankQuestionsPerExam === examQuestionsPerExam, 'bank/exam questionsPerExam differ');
  assert(
    bankQuestionsPerExam >= 0 && bankQuestionsPerExam <= bank.questions.length,
    'questionsPerExam must be 0 or between 1 and question count'
  );

  const seenIds = new Set();
  for (let i = 0; i < bank.questions.length; i++) {
    const bankQuestion = bank.questions[i];
    const examQuestion = exam.questions[i];
    validateQuestion(bankQuestion, i, 'bank');
    validateQuestion(examQuestion, i, 'exam');
    assert(!seenIds.has(bankQuestion.id), 'duplicate question id: ' + bankQuestion.id);
    seenIds.add(bankQuestion.id);
    assert(bankQuestion.id === examQuestion.id, 'question order/id mismatch at index ' + i);
    assert(typeof bankQuestion.correctIndex === 'number', 'bank question ' + bankQuestion.id + ' missing correctIndex');
    assert(bankQuestion.correctIndex >= 0 && bankQuestion.correctIndex <= 3, 'bank question ' + bankQuestion.id + ' correctIndex out of range');
    assert(examQuestion.correctIndex === undefined, 'exam question ' + examQuestion.id + ' leaks correctIndex');
    assert(typeof examQuestion.answerHash === 'string' && examQuestion.answerHash.length === 64, 'exam question ' + examQuestion.id + ' missing answerHash');
    const expectedHash = await hashAnswer(bank.salt, bankQuestion.id, bankQuestion.correctIndex);
    assert(examQuestion.answerHash === expectedHash, 'answerHash mismatch for ' + bankQuestion.id);
  }

  console.log(JSON.stringify({
    ok: true,
    version: bank.version,
    questions: bank.questions.length,
    questionsPerExam: bankQuestionsPerExam,
    firstQuestion: bank.questions[0].id,
    lastQuestion: bank.questions[bank.questions.length - 1].id
  }, null, 2));
}

main().catch(error => fail(error.message));
