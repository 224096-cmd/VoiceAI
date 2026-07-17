if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

import './style.css';
import { Wllama } from '@wllama/wllama';
import nerdamer from 'nerdamer';
import 'nerdamer/Algebra';
import 'nerdamer/Calculus';
import 'nerdamer/Solve';
import 'nerdamer/Extra';
import * as math from 'mathjs';

const MODELS = [
  { id: 'sarashina1b_q4', label: 'sarashina2.2-1B 高精度版（931MB・日本語）' },
  { id: 'tinyswallow15b', label: 'TinySwallow-1.5B（1.13GB・日本語高性能）' },
  { id: 'qwen_coder05b', label: 'Qwen2.5-Coder-0.5B（491MB・コード特化）' },
  { id: 'sarashina1b_iq2xxs', label: 'sarashina2.2-1B 軽量版（542MB・日本語）' },
  { id: 'lfm25_jp', label: 'LFM2.5-1.2B-JP（731MB・日本語）' },
  { id: 'qwen25_15b_q3km', label: 'Qwen2.5-1.5B-Instruct（936MB・汎用高品質）' },
  { id: 'qwen_math15b_iq4nl', label: 'Qwen2.5-Math-1.5B（936MB・数学/論理特化）' },
];

const STORAGE_KEY = 'voiceai-model';
const SETTINGS_KEY = 'voiceai-settings';

const DEFAULT_SETTINGS = {
  temp: 0.7,
  nPredict: 128,
  systemPrompt: 'あなたは親切なアシスタントです。日本語で、必ず{N}トークン程度以内に収まるよう、要点を絞って簡潔に、文の途中で終わらないように答えてください。',
  autoSpeak: false,
};

const N_CTX = 1024;
const MAX_HISTORY = 8;

let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getSystemPrompt() {
  return settings.systemPrompt.replace('{N}', settings.nPredict);
}

const CONFIG_PATHS = {
  'single-thread/wllama.js': '/wllama/wllama.js',
  'single-thread/wllama.wasm': '/wllama/wllama.wasm',
};

const wllama = new Wllama(CONFIG_PATHS);

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const sendBtn = document.getElementById('send');
const inputEl = document.getElementById('input');
const clearCacheBtn = document.getElementById('clearCache');
const clearChatBtn = document.getElementById('clearChat');
const modelSelect = document.getElementById('modelSelect');
const downloadBtn = document.getElementById('downloadBtn');
const charCountEl = document.getElementById('charCount');

let modelLoaded = false;
let conversationHistory = [];
let remindersCache = [];
const recentlyDeletedIds = new Set();

/* ==================== IndexedDB ==================== */

const DB_NAME = 'voiceai-db';
const DB_VERSION = 2;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('favorites')) {
        db.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAdd(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function saveMessageToHistory(role, content) {
  await dbAdd('messages', { role, content, timestamp: Date.now() });
}

/* ==================== ページ切り替え ==================== */

document.querySelectorAll('.tabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.page).classList.add('active');

    if (btn.dataset.page === 'notifPage') loadReminders();
    if (btn.dataset.page === 'historyPage') refreshHistoryPage();
    if (btn.dataset.page === 'scanPage') startCamera();
    else stopCamera();
  });
});

document.querySelectorAll('.subTabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subTabBtn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.subPage').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.sub).classList.add('active');

    document.getElementById('favActions').style.display =
      btn.dataset.sub === 'favoriteList' ? 'flex' : 'none';
    document.getElementById('noteActions').style.display =
      btn.dataset.sub === 'noteList' ? 'flex' : 'none';
  });
});

/* ==================== チャット吹き出し ==================== */

function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

let isSpeaking = false;
let currentSpeakBtn = null;

function toggleSpeak(text, btn) {
  if (!('speechSynthesis' in window)) return;

  if (isSpeaking && currentSpeakBtn === btn) {
    speechSynthesis.cancel();
    isSpeaking = false;
    btn.textContent = '🔊';
    currentSpeakBtn = null;
    return;
  }

  if (isSpeaking && currentSpeakBtn) {
    speechSynthesis.cancel();
    currentSpeakBtn.textContent = '🔊';
  }

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  utter.onend = () => {
    isSpeaking = false;
    btn.textContent = '🔊';
    currentSpeakBtn = null;
  };
  speechSynthesis.speak(utter);
  isSpeaking = true;
  currentSpeakBtn = btn;
  btn.textContent = '⏸';
}

function addBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = role === 'user' ? 'msgWrap msgWrap-user' : 'msgWrap msgWrap-ai';

  const col = document.createElement('div');
  col.className = 'msgCol';

  const bubble = document.createElement('div');
  bubble.className = role === 'user' ? 'msg msg-user' : 'msg msg-ai';
  bubble.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'msgMeta';

  const time = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  meta.appendChild(time);

  if (role === 'ai') {
    const speakBtn = document.createElement('button');
    speakBtn.className = 'msgActionBtn';
    speakBtn.textContent = '🔊';
    speakBtn.addEventListener('click', () => toggleSpeak(text, speakBtn));
    meta.appendChild(speakBtn);

    const favBtn = document.createElement('button');
    favBtn.className = 'msgActionBtn';
    favBtn.textContent = '☆';
    favBtn.addEventListener('click', async () => {
      await dbAdd('favorites', { content: text, timestamp: Date.now() });
      favBtn.textContent = '★';
      favBtn.classList.add('active');
    });
    meta.appendChild(favBtn);
  }

  col.appendChild(bubble);
  col.appendChild(meta);
  wrap.appendChild(col);

  logEl.prepend(wrap);

  saveMessageToHistory(role, text);

  return { wrap, bubble, meta };
}

function pushHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }
}

/* ==================== 字数カウント ==================== */

inputEl.addEventListener('input', () => {
  charCountEl.textContent = `${inputEl.value.length}文字`;
});

/* ==================== モデル選択・ダウンロード ==================== */

function setupModelSelect() {
  MODELS.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  });

  const saved = localStorage.getItem(STORAGE_KEY) || MODELS[0].id;
  modelSelect.value = saved;

  modelSelect.addEventListener('change', () => {
    if (modelLoaded) {
      const ok = confirm('モデルを切り替えます。ページを再読み込みします。よろしいですか？');
      if (!ok) {
        modelSelect.value = localStorage.getItem(STORAGE_KEY) || MODELS[0].id;
        return;
      }
      localStorage.setItem(STORAGE_KEY, modelSelect.value);
      location.reload();
      return;
    }
    localStorage.setItem(STORAGE_KEY, modelSelect.value);
  });
}

async function loadModel() {
  const modelId = modelSelect.value;

  downloadBtn.disabled = true;
  modelSelect.disabled = true;

  statusEl.textContent = 'モデル読み込み中...(初回は数十秒〜数分かかります)';

  try {
    const modelUrl = new URL(
      `/model-proxy.gguf?model=${encodeURIComponent(modelId)}`,
      window.location.href
    ).href;

    await wllama.loadModelFromUrl(modelUrl, {
      n_ctx: N_CTX,
      n_threads: 1,
      progressCallback: ({ loaded, total }) => {
        const pct = Math.round((loaded / total) * 100);
        statusEl.textContent = `モデル読み込み中... ${pct}%`;
      },
    });

    modelLoaded = true;
    statusEl.textContent = '準備完了';

    sendBtn.disabled = false;
    inputEl.disabled = false;
  } catch (error) {
    console.error(error);
    statusEl.textContent = 'モデル読み込みエラー';
    logEl.textContent += `\nエラー:\n${error.message}\n`;
    downloadBtn.disabled = false;
    modelSelect.disabled = false;
  }
}

/* ==================== チャット送信 ==================== */

function setGeneratingStatus(isGenerating) {
  if (isGenerating) {
    statusEl.innerHTML = '<span class="spinner"></span>生成中...';
  } else {
    statusEl.textContent = '準備完了';
  }
}

async function askAI(messages, options = {}) {
  return wllama.createChatCompletion(messages, {
    nPredict: settings.nPredict,
    sampling: { temp: settings.temp, top_k: 40, top_p: 0.9 },
    ...options,
  });
}

function primeSpeechIfNeeded() {
  if (settings.autoSpeak && 'speechSynthesis' in window) {
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0;
    speechSynthesis.speak(primer);
  }
}

async function sendMessage() {
  const userText = inputEl.value.trim();
  if (!userText) return;

  primeSpeechIfNeeded();

  const userRefs = addBubble('user', userText);
  pushHistory('user', userText);

  inputEl.value = '';
  charCountEl.textContent = '0文字';
  sendBtn.disabled = true;

  setGeneratingStatus(true);

  let tokenCount = 0;
  const halfway = Math.floor(settings.nPredict / 2);
  let readMarked = false;

  try {
    let searchContext = '';

    if (searchModeOn) {
      try {
        const searchRes = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userText }),
        });

        if (searchRes.status === 429) {
          searchModeOn = false;
          updateSearchModeButton();
          alert('検索モードの無料枠を使い切ったため、通常モードに切り替えました');
        } else if (searchRes.ok) {
          const { results } = await searchRes.json();
          searchContext = results
            .slice(0, 3)
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.description || ''}`)
            .join('\n\n');
        }
      } catch (e) {
        console.error('検索に失敗しました', e);
      }
    }

    const systemContent = searchContext
      ? `${getSystemPrompt()}\n\n以下はWeb検索結果です。参考にして質問に答えてください。\n${searchContext}`
      : getSystemPrompt();

    const messages = [
      { role: 'system', content: systemContent },
      ...conversationHistory,
    ];

    const outputText = await askAI(messages, {
      onNewToken: () => {
        tokenCount++;
        if (!readMarked && tokenCount >= halfway) {
          readMarked = true;
          const readLabel = document.createElement('span');
          readLabel.textContent = '既読';
          userRefs.meta.appendChild(readLabel);
        }
      },
    });

    const cleaned = stripThinkTags(outputText);
    addBubble('ai', cleaned);
    pushHistory('assistant', cleaned);

    if (settings.autoSpeak) {
      const aiSpeakBtn = logEl.querySelector('.msgWrap-ai .msgActionBtn');
      toggleSpeak(cleaned, aiSpeakBtn);
    }

    setGeneratingStatus(false);
  } catch (error) {
    console.error(error);
    logEl.textContent += `\n生成エラー:\n${error.message}\n`;
    statusEl.textContent = 'エラー';
  }

  sendBtn.disabled = false;
}

/* ==================== クリア系ボタン ==================== */

clearChatBtn.addEventListener('click', () => {
  const ok = confirm('現在の会話をクリアします。よろしいですか？(保存済みの履歴は消えません)');
  if (!ok) return;
  logEl.innerHTML = '';
  conversationHistory = [];
});

clearCacheBtn.addEventListener('click', async () => {
  const ok = confirm('キャッシュとダウンロード済みのモデルデータを完全に削除します。よろしいですか？(再度ダウンロードが必要になります)');
  if (!ok) return;

  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));

  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) {
      names.push(name);
    }
    for (const name of names) {
      await root.removeEntry(name, { recursive: true });
    }
  } catch (e) {
    console.error('OPFSの削除に失敗しました', e);
  }

  alert('キャッシュとモデルデータを削除しました。ページを再読み込みします。');
  location.reload();
});

/* ==================== 計算モード ==================== */

const calcInput = document.getElementById('calcInput');
const calcSend = document.getElementById('calcSend');
const calcResult = document.getElementById('calcResult');
const calcLogEl = document.getElementById('calcLog');
const calcDirectMode = document.getElementById('calcDirectMode');
const calcLogDeleteSelected = document.getElementById('calcLogDeleteSelected');
const calcLogDeleteAll = document.getElementById('calcLogDeleteAll');
const calcCommandsToggle = document.getElementById('calcCommandsToggle');
const calcCommandsPanel = document.getElementById('calcCommandsPanel');

let calcLogItems = [];
let calcLogSeq = 0;

const CALC_SYSTEM_PROMPT = `あなたは数式アシスタントです。ユーザーの日本語の依頼を、以下のいずれか1つのコマンドだけに変換して出力してください。説明や前置きは一切不要で、コマンド文字列だけを出力してください。
diff(式,変数)  … 微分
integrate(式,変数)  … 積分
integrate(式,変数,下限,上限)  … 定積分
solve(式=0,変数)  … 方程式を解く
factor(式)  … 因数分解
expand(式)  … 展開
limit(式,変数=値)  … 極限
simplify(式)  … 簡約
evaluate(式)  … 数値計算
例：「x^2を微分して」→ diff(x^2,x)
例：「x^2-5x+6=0を解いて」→ solve(x^2-5*x+6=0,x)`;

const CALC_COMMANDS = [
  ['+', '足す'], ['-', '引く'], ['*', '掛ける'], ['/', '割る'], ['%', '余り'],
  ['^', 'べき乗'], ['()', '括弧'], ['sqrt()', '平方根'], ['abs()', '絶対値'],
  ['sin()', 'サイン'], ['cos()', 'コサイン'], ['tan()', 'タンジェント'],
  ['asin()', '逆サイン'], ['acos()', '逆コサイン'], ['atan()', '逆タンジェント'],
  ['log()', '自然対数'], ['log10()', '常用対数'], ['log(x,b)', '底bの対数'],
  ['ln()', '自然対数'], ['exp()', '指数関数'], ['diff()', '微分'],
  ['integrate()', '積分'], ['limit()', '極限'], ['expand()', '展開'],
  ['factor()', '因数分解'], ['simplify()', '簡単化'], ['solve()', '方程式を解く'],
  ['subs()', '代入'], ['N()', '数値近似'], ['det()', '行列式'],
  ['inv()', '逆行列'], ['transpose()', '転置行列'], ['eigenvals()', '固有値'],
  ['rank()', '階数'], ['trace()', 'トレース'],
  ['zeros()', '零行列'], ['ones()', '1の行列'], ['eye()', '単位行列'],
  ['sum()', '総和'], ['product()', '総乗'], ['factorial()', '階乗'],
  ['gcd()', '最大公約数'], ['lcm()', '最小公倍数'], ['mod()', '剰余'],
  ['floor()', '切り捨て'], ['ceil()', '切り上げ'], ['round()', '四捨五入'],
  ['min()', '最小値'], ['max()', '最大値'], ['pi', '円周率'],
  ['e', 'ネイピア数'], ['I', '虚数'],
];

function setupCalcCommandsPanel() {
  CALC_COMMANDS.forEach(([cmd, desc]) => {
    const btn = document.createElement('button');
    btn.className = 'calcCmdBtn';
    btn.innerHTML = `<b>${cmd}</b>${desc}`;
    btn.addEventListener('click', () => {
      const cursorPos = calcInput.selectionStart ?? calcInput.value.length;
      const newValue = calcInput.value.slice(0, cursorPos) + cmd + calcInput.value.slice(cursorPos);
      calcInput.value = newValue;

      const parenIndex = cmd.indexOf('()');
      const newCursor = parenIndex !== -1 ? cursorPos + parenIndex + 1 : cursorPos + cmd.length;

      calcInput.focus();
      calcInput.setSelectionRange(newCursor, newCursor);
    });
    calcCommandsPanel.appendChild(btn);
  });
}

calcCommandsToggle.addEventListener('click', () => {
  calcCommandsPanel.classList.toggle('show');
  calcCommandsToggle.textContent = calcCommandsPanel.classList.contains('show')
    ? 'コマンド一覧を隠す'
    : 'コマンド一覧を表示';
});

function renderCalcLog() {
  calcLogEl.innerHTML = '';
  calcLogItems.forEach((item) => {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = item.id;
    const text = document.createElement('span');
    text.textContent = item.text;
    li.appendChild(checkbox);
    li.appendChild(text);
    calcLogEl.appendChild(li);
  });
}

calcLogDeleteSelected.addEventListener('click', () => {
  const checked = Array.from(calcLogEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => Number(el.dataset.id));
  if (checked.length === 0) return;
  calcLogItems = calcLogItems.filter((item) => !checked.includes(item.id));
  renderCalcLog();
});

calcLogDeleteAll.addEventListener('click', () => {
  if (calcLogItems.length === 0) return;
  const ok = confirm('計算履歴をすべて削除します。よろしいですか？');
  if (!ok) return;
  calcLogItems = [];
  renderCalcLog();
});

const MATRIX_FUNCS = ['det', 'inv', 'transpose', 'eigenvals', 'rank', 'trace', 'zeros', 'ones', 'eye'];

function tryMathJs(command) {
  const m = command.match(/^(\w+)\((.*)\)$/s);
  if (!m) return null;
  const [, fn, argsStr] = m;
  if (!MATRIX_FUNCS.includes(fn)) return null;

  if (fn === 'zeros' || fn === 'ones' || fn === 'eye') {
    const dims = argsStr.split(',').map((s) => parseInt(s.trim(), 10));
    const fnName = fn === 'eye' ? 'identity' : fn;
    return math.format(math[fnName](...dims), { precision: 6 });
  }

  const matrix = JSON.parse(argsStr);

  switch (fn) {
    case 'det': return math.format(math.det(matrix), { precision: 6 });
    case 'inv': return math.format(math.inv(matrix), { precision: 6 });
    case 'transpose': return math.format(math.transpose(matrix), { precision: 6 });
    case 'rank': return String(math.rank(matrix));
    case 'trace': return math.format(math.trace(matrix), { precision: 6 });
    case 'eigenvals': return math.format(math.eigs(matrix).values, { precision: 6 });
    default: return null;
  }
}

function tryJsFallback(command) {
  const m = command.match(/^(\w+)\((.*)\)$/s);
  if (!m) return null;
  const [, fn, argsStr] = m;
  const jsFns = ['floor', 'ceil', 'round', 'min', 'max', 'mod', 'gcd', 'lcm', 'factorial'];
  if (!jsFns.includes(fn)) return null;

  const args = argsStr.split(',').map((s) => parseFloat(s.trim()));

  const gcd2 = (a, b) => (b === 0 ? Math.abs(a) : gcd2(b, a % b));

  switch (fn) {
    case 'floor': return String(Math.floor(args[0]));
    case 'ceil': return String(Math.ceil(args[0]));
    case 'round': return String(Math.round(args[0]));
    case 'min': return String(Math.min(...args));
    case 'max': return String(Math.max(...args));
    case 'mod': return String(args[0] % args[1]);
    case 'gcd': return String(args.reduce((a, b) => gcd2(a, b)));
    case 'lcm': return String(args.reduce((a, b) => Math.abs(a * b) / gcd2(a, b)));
    case 'factorial': {
      let result = 1;
      for (let i = 2; i <= args[0]; i++) result *= i;
      return String(result);
    }
    default: return null;
  }
}

const SYMBOLIC_COMMANDS = /^(diff|integrate|factor|expand|simplify|limit)\(/;

function runCalculation(command) {
  const jsResult = tryJsFallback(command);
  if (jsResult !== null) return jsResult;

  const matrixResult = tryMathJs(command);
  if (matrixResult !== null) return matrixResult;

  const solveMatch = command.match(/^solve\(([^,]+)=0\s*,\s*([a-zA-Z]\w*)\)\s*$/);
  if (solveMatch) {
    const [, expr, variable] = solveMatch;
    return nerdamer.solveEquations(expr, variable).toString();
  }

  const evalMatch = command.match(/^evaluate\((.+)\)\s*$/);
  if (evalMatch) {
    return nerdamer(evalMatch[1]).evaluate().toString();
  }

  if (SYMBOLIC_COMMANDS.test(command)) {
    return nerdamer(command).toString();
  }

  let evalCommand = command;
  evalCommand = evalCommand.replace(/\b(sin|cos|tan)\(([^()]+)\)/g, '$1(($2)*pi/180)');
  evalCommand = evalCommand.replace(/\b(asin|acos|atan)\(([^()]+)\)/g, '(($1($2))*180/pi)');

  try {
    return nerdamer(evalCommand).evaluate().toString();
  } catch (e) {
    return nerdamer(command).toString();
  }
}

async function handleCalcSend() {
  const query = calcInput.value.trim();
  if (!query) return;

  calcInput.value = '';
  calcResult.textContent = '計算中...';

  try {
    let command = query;

    if (!calcDirectMode.checked) {
      if (!modelLoaded) {
        calcResult.textContent = 'AI変換にはチャットページでモデルを読み込んでおく必要があります';
        return;
      }
      const raw = await askAI([
        { role: 'system', content: CALC_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ]);
      command = stripThinkTags(raw).trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
    }

    const resultText = runCalculation(command);
    calcResult.textContent = resultText;

    calcLogSeq += 1;
    calcLogItems.unshift({
      id: calcLogSeq,
      text: calcDirectMode.checked
        ? `${command} = ${resultText}`
        : `${query} → ${command} = ${resultText}`,
    });
    renderCalcLog();
  } catch (error) {
    console.error(error);
    calcResult.textContent = '計算できませんでした（この式・コマンドには対応していない可能性があります）';
  }
}

calcSend.addEventListener('click', handleCalcSend);
calcInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) handleCalcSend();
});

/* ==================== スキャン (カメラ / OCR / QR) ==================== */

const scanVideo = document.getElementById('scanVideo');
const scanPreviewWrap = document.getElementById('scanPreviewWrap');
const scanPreview = document.getElementById('scanPreview');
const scanCropOverlay = document.getElementById('scanCropOverlay');
const scanCanvas = document.getElementById('scanCanvas');
const scanCaptureBtn = document.getElementById('scanCaptureBtn');
const scanRetakeBtn = document.getElementById('scanRetakeBtn');
const scanSaveAlbumBtn = document.getElementById('scanSaveAlbumBtn');
const ocrBtn = document.getElementById('ocrBtn');
const qrBtn = document.getElementById('qrBtn');
const scanStatus = document.getElementById('scanStatus');
const scanResult = document.getElementById('scanResult');
const scanResultActions = document.getElementById('scanResultActions');
const scanSendToChat = document.getElementById('scanSendToChat');
const scanSaveHint = document.getElementById('scanSaveHint');

let cropRect = { x: 0, y: 0, w: 1, h: 1 };
let dragging = false;
let dragStart = null;

let mediaStream = null;

async function startCamera() {
  if (mediaStream) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    scanVideo.srcObject = mediaStream;
  } catch (e) {
    console.error(e);
    scanStatus.textContent = 'カメラを起動できませんでした（権限を確認してください）';
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function updateOverlayFromRect() {
  scanCropOverlay.style.left = `${cropRect.x * 100}%`;
  scanCropOverlay.style.top = `${cropRect.y * 100}%`;
  scanCropOverlay.style.width = `${cropRect.w * 100}%`;
  scanCropOverlay.style.height = `${cropRect.h * 100}%`;
}

function pointerToLocal(e) {
  const rect = scanPreviewWrap.getBoundingClientRect();
  return {
    x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
  };
}

scanPreviewWrap.addEventListener('pointerdown', (e) => {
  if (!scanPreviewWrap.classList.contains('show')) return;
  dragging = true;
  dragStart = pointerToLocal(e);
  e.preventDefault();
});

scanPreviewWrap.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const pos = pointerToLocal(e);
  const x = Math.min(dragStart.x, pos.x);
  const y = Math.min(dragStart.y, pos.y);
  const w = Math.max(Math.abs(pos.x - dragStart.x), 0.02);
  const h = Math.max(Math.abs(pos.y - dragStart.y), 0.02);
  cropRect = { x, y, w, h };
  updateOverlayFromRect();
  e.preventDefault();
});

scanPreviewWrap.addEventListener('pointerup', () => { dragging = false; });
scanPreviewWrap.addEventListener('pointercancel', () => { dragging = false; });

function getCroppedCanvas() {
  const top = cropRect.y * scanCanvas.height;
  const left = cropRect.x * scanCanvas.width;
  const width = cropRect.w * scanCanvas.width;
  const height = cropRect.h * scanCanvas.height;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  outCanvas.getContext('2d').drawImage(scanCanvas, left, top, width, height, 0, 0, width, height);
  return outCanvas;
}

async function savePhotoToAlbum(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], `voiceai-${Date.now()}.png`, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    console.error('共有に失敗しました', e);
  }

  alert('この端末では自動保存に対応していません。画像を長押しして「写真に追加」を選んでください。');
}

scanCaptureBtn.addEventListener('click', () => {
  if (!scanVideo.videoWidth) {
    scanStatus.textContent = 'カメラの準備ができていません';
    return;
  }

  scanCanvas.width = scanVideo.videoWidth;
  scanCanvas.height = scanVideo.videoHeight;
  scanCanvas.getContext('2d').drawImage(scanVideo, 0, 0);

  const dataUrl = scanCanvas.toDataURL('image/png');
  scanPreview.src = dataUrl;
  scanPreviewWrap.classList.add('show');
  scanVideo.style.display = 'none';

  scanCaptureBtn.style.display = 'none';
  scanRetakeBtn.style.display = 'block';
  scanSaveAlbumBtn.style.display = 'block';

  ocrBtn.disabled = false;
  qrBtn.disabled = false;
  scanResult.textContent = '';
  scanResultActions.style.display = 'none';

  cropRect = { x: 0, y: 0, w: 1, h: 1 };
  updateOverlayFromRect();
  scanSaveHint.style.display = 'block';

  dbAdd('messages', { role: 'photo', content: dataUrl, timestamp: Date.now() });
});

scanRetakeBtn.addEventListener('click', () => {
  scanPreviewWrap.classList.remove('show');
  scanVideo.style.display = 'block';
  scanCaptureBtn.style.display = 'block';
  scanRetakeBtn.style.display = 'none';
  scanSaveAlbumBtn.style.display = 'none';
  scanSaveHint.style.display = 'none';
  ocrBtn.disabled = true;
  qrBtn.disabled = true;
  scanResult.textContent = '';
  scanStatus.textContent = '';
});

scanSaveAlbumBtn.addEventListener('click', () => savePhotoToAlbum(scanPreview.src));

ocrBtn.addEventListener('click', async () => {
  scanStatus.textContent = 'OCR処理中...(初回はライブラリのダウンロードが入ります)';
  scanResult.textContent = '';

  try {
    const { createWorker } = await import('tesseract.js');
    const cropped = getCroppedCanvas();

    const worker = await createWorker('jpn+eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@v5.0.0/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.0.0',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    });

    const { data } = await worker.recognize(cropped);
    await worker.terminate();

    scanResult.textContent = data.text.trim() || '(文字が認識できませんでした)';
    scanResultActions.style.display = 'flex';
    scanStatus.textContent = '完了';
  } catch (error) {
    console.error(error);
    scanStatus.textContent = `OCRに失敗しました: ${error.message}`;
  }
});

qrBtn.addEventListener('click', async () => {
  scanStatus.textContent = '読み取り中...';
  scanResult.textContent = '';

  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const cropped = getCroppedCanvas();
    const reader = new BrowserMultiFormatReader();
    const result = await reader.decodeFromCanvas(cropped);

    scanResult.textContent = result.getText();
    scanResultActions.style.display = 'flex';
    scanStatus.textContent = '完了';
  } catch (error) {
    console.error(error);
    scanStatus.textContent = 'QR/バーコードが見つかりませんでした';
  }
});

scanSendToChat.addEventListener('click', () => {
  document.querySelector('.tabBtn[data-page="chatPage"]').click();
  inputEl.value = scanResult.textContent;
  charCountEl.textContent = `${inputEl.value.length}文字`;
  inputEl.focus();
});

scanCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(scanResult.textContent);
    scanStatus.textContent = 'コピーしました';
  } catch (e) {
    alert('コピーに失敗しました');
  }
});

/* ==================== 履歴・お気に入り・メモ ==================== */

const historyListEl = document.getElementById('historyList');
const favoriteListEl = document.getElementById('favoriteList');
const noteListEl = document.getElementById('noteList');
const historySearchEl = document.getElementById('historySearch');

function renderHistoryList(items) {
  historyListEl.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = '履歴はありません';
    historyListEl.appendChild(li);
    return;
  }

  [...items].reverse().forEach((item) => {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = item.id;

    const body = document.createElement('div');
    body.className = 'itemBody';

    if (item.role === 'photo') {
      body.innerHTML = `<div class="itemMeta">${new Date(item.timestamp).toLocaleString('ja-JP')} ・ 写真</div>`;
      const img = document.createElement('img');
      img.className = 'historyPhoto';
      img.src = item.content;
      body.appendChild(img);
    } else {
      const roleLabel = item.role === 'user' ? 'あなた' : 'AI';
      body.innerHTML = `<div class="itemMeta">${new Date(item.timestamp).toLocaleString('ja-JP')} ・ ${roleLabel}</div>${item.content}`;
    }

    li.appendChild(checkbox);
    li.appendChild(body);
    historyListEl.appendChild(li);
  });
}

function renderFavoriteList(items) {
  favoriteListEl.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'お気に入りはありません';
    favoriteListEl.appendChild(li);
    return;
  }

  [...items].reverse().forEach((item) => {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = item.id;

    const body = document.createElement('div');
    body.className = 'itemBody';
    const meta = document.createElement('div');
    meta.className = 'itemMeta';
    meta.textContent = new Date(item.timestamp).toLocaleString('ja-JP');
    body.appendChild(meta);
    body.appendChild(document.createTextNode(item.content));

    li.appendChild(checkbox);
    li.appendChild(body);
    favoriteListEl.appendChild(li);
  });
}

let notesCache = [];
let editingNoteId = null;

function renderNoteList(items) {
  noteListEl.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'メモはありません';
    noteListEl.appendChild(li);
    return;
  }

  [...items].reverse().forEach((item) => {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = item.id;

    const body = document.createElement('div');
    body.className = 'itemBody';
    body.innerHTML = `<div class="itemMeta">${new Date(item.timestamp).toLocaleString('ja-JP')}</div><b>${item.title || '(無題)'}</b><br>${item.content}`;
    body.addEventListener('click', () => openNoteEditor(item));

    li.appendChild(checkbox);
    li.appendChild(body);
    noteListEl.appendChild(li);
  });
}

function openNoteEditor(note) {
  editingNoteId = note ? note.id : null;
  document.getElementById('noteTitleInput').value = note ? note.title : '';
  document.getElementById('noteContentInput').value = note ? note.content : '';
  document.getElementById('noteEditor').style.display = 'flex';
}

document.getElementById('noteNewBtn').addEventListener('click', () => openNoteEditor(null));

document.getElementById('noteCancelBtn').addEventListener('click', () => {
  document.getElementById('noteEditor').style.display = 'none';
  editingNoteId = null;
});

document.getElementById('noteSaveBtn').addEventListener('click', async () => {
  const title = document.getElementById('noteTitleInput').value.trim();
  const content = document.getElementById('noteContentInput').value.trim();
  if (!content) {
    alert('内容を入力してください');
    return;
  }

  if (editingNoteId) {
    await dbPut('notes', { id: editingNoteId, title, content, timestamp: Date.now() });
  } else {
    await dbAdd('notes', { title, content, timestamp: Date.now() });
  }

  document.getElementById('noteEditor').style.display = 'none';
  editingNoteId = null;
  refreshHistoryPage(historySearchEl.value.trim());
});

async function refreshHistoryPage(keyword = '') {
  const [messages, favorites, notes] = await Promise.all([
    dbGetAll('messages'),
    dbGetAll('favorites'),
    dbGetAll('notes'),
  ]);

  notesCache = notes;

  const filteredMessages = keyword
    ? messages.filter((m) => m.role !== 'photo' && m.content.includes(keyword))
    : messages;

  const filteredNotes = keyword
    ? notes.filter((n) => n.title.includes(keyword) || n.content.includes(keyword))
    : notes;

  renderHistoryList(filteredMessages);
  renderFavoriteList(favorites);
  renderNoteList(filteredNotes);
}

historySearchEl.addEventListener('input', () => {
  refreshHistoryPage(historySearchEl.value.trim());
});

document.getElementById('historyDeleteSelected').addEventListener('click', async () => {
  const checked = Array.from(historyListEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => Number(el.dataset.id));
  if (checked.length === 0) return;
  await Promise.all(checked.map((id) => dbDelete('messages', id)));
  refreshHistoryPage(historySearchEl.value.trim());
});

document.getElementById('historyDeleteAll').addEventListener('click', async () => {
  const ok = confirm('会話履歴をすべて削除します。よろしいですか？');
  if (!ok) return;
  await dbClear('messages');
  refreshHistoryPage();
});

document.getElementById('favDeleteSelected').addEventListener('click', async () => {
  const checked = Array.from(favoriteListEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => Number(el.dataset.id));
  if (checked.length === 0) return;
  await Promise.all(checked.map((id) => dbDelete('favorites', id)));
  refreshHistoryPage(historySearchEl.value.trim());
});

document.getElementById('favDeleteAll').addEventListener('click', async () => {
  const ok = confirm('お気に入りをすべて削除します。よろしいですか？');
  if (!ok) return;
  await dbClear('favorites');
  refreshHistoryPage();
});

document.getElementById('noteDeleteSelected').addEventListener('click', async () => {
  const checked = Array.from(noteListEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => Number(el.dataset.id));
  if (checked.length === 0) return;
  await Promise.all(checked.map((id) => dbDelete('notes', id)));
  refreshHistoryPage(historySearchEl.value.trim());
});

document.getElementById('noteDeleteAll').addEventListener('click', async () => {
  const ok = confirm('メモをすべて削除します。よろしいですか？');
  if (!ok) return;
  await dbClear('notes');
  refreshHistoryPage();
});

/* ==================== AI設定 ==================== */

const settingTemp = document.getElementById('settingTemp');
const settingTempVal = document.getElementById('settingTempVal');
const settingTokens = document.getElementById('settingTokens');
const settingSystemPrompt = document.getElementById('settingSystemPrompt');
const settingAutoSpeak = document.getElementById('settingAutoSpeak');
const settingSave = document.getElementById('settingSave');
const settingReset = document.getElementById('settingReset');

function applySettingsToForm() {
  settingTemp.value = settings.temp;
  settingTempVal.textContent = settings.temp;
  settingTokens.value = settings.nPredict;
  settingSystemPrompt.value = settings.systemPrompt;
  settingAutoSpeak.checked = settings.autoSpeak;
}

settingTemp.addEventListener('input', () => {
  settingTempVal.textContent = settingTemp.value;
});

settingSave.addEventListener('click', () => {
  settings = {
    temp: parseFloat(settingTemp.value),
    nPredict: parseInt(settingTokens.value, 10) || DEFAULT_SETTINGS.nPredict,
    systemPrompt: settingSystemPrompt.value || DEFAULT_SETTINGS.systemPrompt,
    autoSpeak: settingAutoSpeak.checked,
  };
  saveSettings();
  alert('設定を保存しました');
});

settingReset.addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  applySettingsToForm();
});

/* ==================== プッシュ通知 ==================== */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('この端末/ブラウザはプッシュ通知に対応していません');
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    alert('通知が許可されませんでした');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch('/api/vapid-public-key').then((r) => r.json());

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });

  alert('通知を有効化しました');
}

/* ==================== 予定(リマインダー) ==================== */

function setupReminderCountSelect() {
  const sel = document.getElementById('reminderCount');
  for (let i = 1; i <= 5; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i}回`;
    sel.appendChild(opt);
  }
}

function renderReminders() {
  const listEl = document.getElementById('reminderList');
  listEl.innerHTML = '';

  if (remindersCache.length === 0) {
    const li = document.createElement('li');
    li.textContent = '設定済みの予定はありません';
    listEl.appendChild(li);
    return;
  }

  const sorted = [...remindersCache].sort((a, b) => a.time - b.time);

  sorted.forEach((r) => {
    const li = document.createElement('li');

    const label = document.createElement('span');
    label.textContent = `${new Date(r.time).toLocaleString('ja-JP')} ${r.title}（残り${r.remainingCount}/${r.totalCount}回）`;

    const delBtn = document.createElement('button');
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      recentlyDeletedIds.add(r.id);
      remindersCache = remindersCache.filter((item) => item.id !== r.id);
      renderReminders();
      await fetch(`/api/reminders/${r.id}`, { method: 'DELETE' });
    });

    li.appendChild(label);
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
}

async function loadReminders() {
  try {
    const serverList = await fetch('/api/reminders').then((r) => r.json());

    const merged = new Map();
    remindersCache.forEach((r) => merged.set(r.id, r));
    serverList.forEach((r) => {
      if (!recentlyDeletedIds.has(r.id)) merged.set(r.id, r);
    });
    recentlyDeletedIds.forEach((id) => merged.delete(id));

    remindersCache = Array.from(merged.values());
    renderReminders();
  } catch (e) {
    console.error('予定の取得に失敗しました', e);
  }
}

async function addReminder() {
  const timeEl = document.getElementById('reminderTime');
  const titleEl = document.getElementById('reminderTitle');
  const countEl = document.getElementById('reminderCount');

  if (!timeEl.value) {
    alert('日時を選択してください');
    return;
  }

  const epoch = new Date(timeEl.value).getTime();
  const count = parseInt(countEl.value, 10) || 1;
  const title = titleEl.value || 'VoiceAI';

  const payload = {
    time: epoch,
    title,
    body: '設定した予定の時間になりました',
    count,
  };

  try {
    const created = await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());

    remindersCache.push(created);
    renderReminders();

    timeEl.value = '';
    titleEl.value = '';
  } catch (e) {
    console.error('予定の追加に失敗しました', e);
    alert('予定の追加に失敗しました');
  }
}

document.getElementById('enablePush').addEventListener('click', enablePush);
document.getElementById('addReminder').addEventListener('click', addReminder);

/* ==================== 初期化 ==================== */

downloadBtn.addEventListener('click', loadModel);
sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    sendMessage();
  }
});

/* ==================== 広告(Adsterra) ==================== */

const adSlot = document.getElementById('adSlot');
const offlineLabel = document.getElementById('offlineLabel');
let adLoaded = false;

function isLocalHost() {
  return ['localhost', '127.0.0.1'].includes(location.hostname);
}

function loadAdsterraAd() {
  if (adLoaded) return;
  adLoaded = true;

  const iframe = document.createElement('iframe');
  iframe.style.width = '320px';
  iframe.style.height = '50px';
  iframe.style.border = 'none';
  iframe.style.overflow = 'hidden';
  adSlot.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <script type="text/javascript">
      atOptions = {
        'key' : 'b6a75cf8c9329c454ac31d89fd6aa38b',
        'format' : 'iframe',
        'height' : 50,
        'width' : 320,
        'params' : {}
      };
    <\/script>
    <script type="text/javascript" src="https://www.highperformanceformat.com/b6a75cf8c9329c454ac31d89fd6aa38b/invoke.js"><\/script>
  `);
  doc.close();
}

function updateHeaderState() {
  if (!navigator.onLine) {
    adSlot.style.display = 'none';
    offlineLabel.style.display = 'block';
    return;
  }

  offlineLabel.style.display = 'none';
  adSlot.style.display = 'block';

  if (!isLocalHost()) {
    loadAdsterraAd();
  }
}

window.addEventListener('online', updateHeaderState);
window.addEventListener('offline', updateHeaderState);
updateHeaderState();

/* ==================== 検索モード ==================== */

let searchModeOn = false;

function updateSearchModeButton() {
  const btn = document.getElementById('searchModeToggle');
  btn.textContent = searchModeOn ? '🔎 検索ON' : '🔎 検索OFF';
  btn.classList.toggle('active', searchModeOn);
}

document.getElementById('searchModeToggle').addEventListener('click', () => {
  searchModeOn = !searchModeOn;
  updateSearchModeButton();
});

setupModelSelect();
setupReminderCountSelect();
setupCalcCommandsPanel();
applySettingsToForm();