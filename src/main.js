if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => {
    console.error('Service Worker登録に失敗しました', e);
  });
}

import '../style.css';
import { Wllama } from '@wllama/wllama';
import nerdamer from 'nerdamer';
import 'nerdamer/Algebra';
import 'nerdamer/Calculus';
import 'nerdamer/Solve';
import 'nerdamer/Extra';
import * as math from 'mathjs';

const MODELS = [
  { id: 'sarashina1b_q4', label: 'sarashina2.2-1B（931MB・日本語特化・高品質会話向け・SB Intuitionsソフトバンクグループ）' },
  { id: 'tinyswallow15b', label: 'TinySwallow-1.5B（1.13GB・日本語特化・高品質会話向け・Sakana AI）' },
  { id: 'qwen_coder05b', label: 'Qwen2.5-Coder-0.5B（491MB・軽量・コード生成特化・Alibaba）' },
  { id: 'sarashina1b_iq2xxs', label: 'sarashina2.2-1B IQ2_XXS（542MB・軽量・日本語会話向け・SB Intuitionsソフトバンクグループ）' },
  { id: 'lfm25_jp', label: 'LFM2.5-1.2B-JP（731MB・日本語特化・高速会話向け・Liquid AI）' },
  { id: 'qwen25_15b_q3km', label: 'Qwen2.5-1.5B-Instruct（936MB・汎用・文章生成向け・Alibaba）' },
  { id: 'gemma3_1b_iq1m', label: 'Gemma3-1B-IT UD-IQ1_M（560MB・軽量・基本会話向け・Google）' },
  { id: 'gemma3_1b_q4km', label: 'Gemma3-1B-IT Q4_K_M（806MB・汎用・高品質会話向け・Google）' },
  { id: 'gemma3_1b_bf16', label: 'Gemma3-1B-IT BF16（2.01GB・高品質・高性能端末のみ対応・Google）' },
  { id: 'qwen_math15b_q4km', label: 'Qwen2.5-Math-1.5B（986MB・数学・論理推論特化・Alibaba）' },
];

const STORAGE_KEY = 'voiceai-model';
const SETTINGS_KEY = 'voiceai-settings';

const DEFAULT_SETTINGS = {
  temp: 0.7,
  nPredict: 128,
  topK: 40,
  topP: 0.9,
  systemPrompt: 'あなたは親切なアシスタントです。日本語で、必ず{N}トークン程度以内に収まるよう、要点を絞って簡潔に、文の途中で終わらないように答えてください。',
  ttsMode: 'off',
  streamingDisplay: false,
  historyLength: 8,
};

const N_CTX = 1024;

const USER_ID_KEY = 'voiceai-user-id';

function getUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

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
const deleteModelBtn = document.getElementById('deleteModel');
const modelSelect = document.getElementById('modelSelect');
const downloadBtn = document.getElementById('downloadBtn');
const charCountEl = document.getElementById('charCount');

let modelLoaded = false;
let conversationHistory = [];
let remindersCache = [];
const recentlyDeletedIds = new Set();

let isGenerating = false;
let messageQueue = [];

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

let kokoroTTS = null;
let kokoroLoadingPromise = null;

async function ensureKokoroLoaded() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoadingPromise) return kokoroLoadingPromise;

  kokoroLoadingPromise = (async () => {
    const prevStatus = statusEl.textContent;
    statusEl.textContent = '音声モデルをダウンロード中...(初回のみ)';

    const { KokoroTTS } = await import('kokoro-js');
    const { env } = await import('@huggingface/transformers');

    env.remoteHost = new URL('/hf-proxy/', window.location.href).href;

    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
    });
    kokoroTTS = tts;
    statusEl.textContent = prevStatus;
    return tts;
  })();

  return kokoroLoadingPromise;
}

async function speakHighQuality(text) {
  try {
    const tts = await ensureKokoroLoaded();
    const audio = await tts.generate(text, { voice: 'jf_alpha' });
    const blob = await audio.toBlob();
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    player.play();
  } catch (e) {
    console.error('高性能読み上げに失敗しました。標準の読み上げに切り替えます', e);
    speakOnce(text);
  }
}

function speakBySettings(text) {
  if (settings.ttsMode === 'high') {
    speakHighQuality(text);
  } else if (settings.ttsMode === 'default') {
    speakOnce(text);
  }
}

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

function speakOnce(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  speechSynthesis.speak(utter);
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
    if (settings.ttsMode !== 'off') {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'msgActionBtn';
      speakBtn.textContent = '🔊';
      speakBtn.addEventListener('click', () => {
        if (settings.ttsMode === 'high') {
          speakHighQuality(text);
        } else {
          toggleSpeak(text, speakBtn);
        }
      });
      meta.appendChild(speakBtn);
    }

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
  const limit = settings.historyLength;
  if (limit > 0 && conversationHistory.length > limit) {
    conversationHistory = conversationHistory.slice(-limit);
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

  modelSelect.addEventListener('change', async () => {
    if (modelLoaded) {
      const ok = confirm('モデルを切り替えます。今のモデルのデータを削除して再読み込みします。よろしいですか？');
      if (!ok) {
        modelSelect.value = localStorage.getItem(STORAGE_KEY) || MODELS[0].id;
        return;
      }

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
        console.error('旧モデルデータの削除に失敗しました', e);
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

/* ==================== チャット送信(送信ボタンは生成中も使え、順番に処理) ==================== */

function setGeneratingStatus() {
  if (isGenerating) {
    const waiting = messageQueue.length;
    statusEl.innerHTML = `<span class="spinner"></span>生成中...${waiting > 0 ? `(待機 ${waiting}件)` : ''}`;
  } else {
    statusEl.textContent = '準備完了';
  }
}

async function askAI(messages, options = {}) {
  return wllama.createChatCompletion(messages, {
    nPredict: settings.nPredict,
    sampling: { temp: settings.temp, top_k: settings.topK, top_p: settings.topP },
    ...options,
  });
}

function primeSpeechIfNeeded() {
  if (settings.ttsMode === 'default' && 'speechSynthesis' in window) {
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0;
    speechSynthesis.speak(primer);
  }
}

function sendMessage() {
  const userText = inputEl.value.trim();
  if (!userText) return;

  primeSpeechIfNeeded();

  const userRefs = addBubble('user', userText);

  inputEl.value = '';
  charCountEl.textContent = '0文字';

  setTimeout(() => {
    const readLabel = document.createElement('span');
    readLabel.textContent = '既読';
    userRefs.meta.appendChild(readLabel);
  }, 5000);

  messageQueue.push(userText);
  setGeneratingStatus();
  processQueue();
}

async function processQueue() {
  if (isGenerating) return;
  const userText = messageQueue.shift();
  if (userText === undefined) return;

  isGenerating = true;
  setGeneratingStatus();

  pushHistory('user', userText);

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

    let outputText;

    if (settings.streamingDisplay) {
      const aiRefs = addBubble('ai', '');
      outputText = await askAI(messages, {
        onNewToken: (token, piece, currentText) => {
          aiRefs.bubble.textContent = stripThinkTags(currentText) || '…';
        },
      });
      const cleaned = stripThinkTags(outputText);
      aiRefs.bubble.textContent = cleaned;
      pushHistory('assistant', cleaned);
      speakBySettings(cleaned);
    } else {
      outputText = await askAI(messages);
      const cleaned = stripThinkTags(outputText);
      addBubble('ai', cleaned);
      pushHistory('assistant', cleaned);
      speakBySettings(cleaned);
    }

  } catch (error) {
    console.error(error);
    logEl.textContent += `\n生成エラー:\n${error.message}\n`;
  }

  isGenerating = false;
  setGeneratingStatus();
  processQueue();
}

/* ==================== クリア系ボタン ==================== */

clearChatBtn.addEventListener('click', () => {
  const ok = confirm('現在の会話をクリアします。よろしいですか？(保存済みの履歴は消えません)');
  if (!ok) return;
  logEl.innerHTML = '';
  conversationHistory = [];
});

deleteModelBtn.addEventListener('click', async () => {
  const ok = confirm('ダウンロード済みのAIモデルデータを削除します。よろしいですか？(再度ダウンロードが必要になります)');
  if (!ok) return;

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
    console.error('AIモデルの削除に失敗しました', e);
  }

  localStorage.removeItem(STORAGE_KEY);
  modelLoaded = false;
  downloadBtn.disabled = false;
  modelSelect.disabled = false;
  sendBtn.disabled = true;
  inputEl.disabled = true;
  statusEl.textContent = 'モデルを選んで「ダウンロード開始」を押してください';

  alert('AIモデルのデータを削除しました。');
});

clearCacheBtn.addEventListener('click', async () => {
  const ok = confirm('アプリのキャッシュ(HTML/CSS/JSなど)を削除します。よろしいですか？');
  if (!ok) return;

  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));

  alert('キャッシュを削除しました。ページを再読み込みします。');
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

const CALC_EXAMPLES = {
  '+': '3+5', '-': '10-4', '*': '6*7', '/': '20/4', '%': '17%5', '^': '2^10',
  '()': '(2+3)*4', 'sqrt()': 'sqrt(16)', 'abs()': 'abs(-7)',
  'sin()': 'sin(45)', 'cos()': 'cos(pi/2)', 'tan()': 'tan(45)',
  'asin()': 'asin(0.5)', 'acos()': 'acos(0.5)', 'atan()': 'atan(1)',
  'log()': 'log(e)', 'log10()': 'log10(1000)', 'log(x,b)': 'log(8,2)',
  'ln()': 'ln(e)', 'exp()': 'exp(1)',
  'diff()': 'diff(x^2,x)', 'integrate()': 'integrate(x^2,x)', 'limit()': 'limit(sin(x)/x,x=0)',
  'expand()': 'expand((x+1)^2)', 'factor()': 'factor(x^2-1)', 'simplify()': 'simplify((x^2-1)/(x-1))',
  'solve()': 'solve(x^2-5*x+6=0,x)', 'subs()': 'subs(x^2+1,x,3)', 'N()': 'N(sqrt(2))',
  'det()': 'det([[1,2],[3,4]])', 'inv()': 'inv([[1,2],[3,4]])', 'transpose()': 'transpose([[1,2],[3,4]])',
  'eigenvals()': 'eigenvals([[2,0],[0,3]])', 'rank()': 'rank([[1,2],[2,4]])', 'trace()': 'trace([[1,2],[3,4]])',
  'zeros()': 'zeros(2,2)', 'ones()': 'ones(2,2)', 'eye()': 'eye(3)',
  'sum()': 'sum(1,2,3,4)', 'product()': 'product(2,3,4)', 'factorial()': 'factorial(5)',
  'gcd()': 'gcd(12,18)', 'lcm()': 'lcm(4,6)', 'mod()': 'mod(17,5)',
  'floor()': 'floor(3.7)', 'ceil()': 'ceil(3.2)', 'round()': 'round(3.5)',
  'min()': 'min(4,9,2)', 'max()': 'max(4,9,2)', 'pi': 'pi', 'e': 'e', 'I': 'I^2',
};

function buildCalcExamplesHtml() {
  const rows = CALC_COMMANDS.map(([cmd, desc]) => {
    const example = CALC_EXAMPLES[cmd] || cmd;
    return `<tr><td><code>${cmd}</code></td><td>${desc}</td><td><code>${example}</code></td></tr>`;
  }).join('');

  return `
    <h2>計算コマンドの入力例</h2>
    <p>計算タブの「直接コマンドを入力する」をONにした状態で、以下のように入力してください。</p>
    <table id="cmdTable">
      <tr><th>コマンド</th><th>説明</th><th>入力例</th></tr>
      ${rows}
    </table>
  `;
}

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
    case 'rank': {
      try {
        const lup = math.lup(matrix);
        const diag = math.diag(lup.U);
        const r = diag.valueOf().filter((val) => Math.abs(val) > 1e-9).length;
        return String(r);
      } catch (e) {
        return '0';
      }
    }
    case 'trace': return math.format(math.trace(matrix), { precision: 6 });
    case 'eigenvals': return math.format(math.eigs(matrix).values, { precision: 6 });
    default: return null;
  }
}

function tryJsFallback(command) {
  const m = command.match(/^(\w+)\((.*)\)$/s);
  if (!m) return null;
  const [, fn, argsStr] = m;
  const jsFns = ['floor', 'ceil', 'round', 'min', 'max', 'mod', 'gcd', 'lcm', 'factorial', 'sum', 'product'];
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
    case 'sum': return String(args.reduce((a, b) => a + b, 0));
    case 'product': return String(args.reduce((a, b) => a * b, 1));
    default: return null;
  }
}

const SYMBOLIC_COMMANDS = /^(diff|integrate|factor|expand|simplify|limit)\(/;

function toCleanNumber(nerdamerResult) {
  const numeric = Number(nerdamerResult.valueOf());
  if (Number.isFinite(numeric)) {
    const rounded = parseFloat(numeric.toPrecision(10));
    return String(rounded);
  }
  return nerdamerResult.toString();
}

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
    return toCleanNumber(nerdamer(evalMatch[1]).evaluate());
  }

  const nMatch = command.match(/^N\((.+)\)\s*$/);
  if (nMatch) {
    return toCleanNumber(nerdamer(nMatch[1]).evaluate());
  }

  const subsMatch = command.match(/^subs\((.+),\s*([a-zA-Z]\w*)\s*,\s*(.+)\)\s*$/);
  if (subsMatch) {
    const [, expr, variable, value] = subsMatch;
    return toCleanNumber(nerdamer(expr).sub(variable, value).evaluate());
  }

  if (SYMBOLIC_COMMANDS.test(command)) {
    return nerdamer(command).toString();
  }

  let evalCommand = command;

  evalCommand = evalCommand.replace(/\b(sin|cos|tan)\(([^()]+)\)/g, (match, fn, arg) => {
    const isPureNumber = /^-?\d+(\.\d+)?$/.test(arg.trim());
    return isPureNumber ? `${fn}((${arg})*pi/180)` : match;
  });

  evalCommand = evalCommand.replace(/\b(asin|acos|atan)\(([^()]+)\)/g, (match, fn, arg) => {
    const isPureNumber = /^-?\d+(\.\d+)?$/.test(arg.trim());
    return isPureNumber ? `((${fn}(${arg}))*180/pi)` : match;
  });

  try {
    return toCleanNumber(nerdamer(evalCommand).evaluate());
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
const scanCopyBtn = document.getElementById('scanCopyBtn');
const scanSaveHint = document.getElementById('scanSaveHint');

let cropRect = { x: 0, y: 0, w: 1, h: 1 };
let dragging = false;
let dragStart = null;
let mediaStream = null;
let zoomLevel = 1;

function applyDigitalZoom() {
  scanVideo.style.transform = `scale(${zoomLevel})`;
}

document.getElementById('zoomSlider').addEventListener('input', (e) => {
  zoomLevel = parseFloat(e.target.value);
  applyDigitalZoom();
});

async function startCamera() {
  if (mediaStream) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    scanVideo.srcObject = mediaStream;
    document.getElementById('zoomRow').style.display = 'flex';
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

  const vw = scanVideo.videoWidth;
  const vh = scanVideo.videoHeight;
  const cropW = vw / zoomLevel;
  const cropH = vh / zoomLevel;
  const cropX = (vw - cropW) / 2;
  const cropY = (vh - cropH) / 2;

  scanCanvas.width = cropW;
  scanCanvas.height = cropH;
  scanCanvas.getContext('2d').drawImage(scanVideo, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

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

  zoomLevel = 1;
  document.getElementById('zoomSlider').value = 1;
  applyDigitalZoom();
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
const settingTopK = document.getElementById('settingTopK');
const settingTopP = document.getElementById('settingTopP');
const settingTopPVal = document.getElementById('settingTopPVal');
const settingSystemPrompt = document.getElementById('settingSystemPrompt');
const settingTtsMode = document.getElementById('settingTtsMode');
const settingHistoryLength = document.getElementById('settingHistoryLength');
const settingStreaming = document.getElementById('settingStreaming');
const settingSave = document.getElementById('settingSave');
const settingReset = document.getElementById('settingReset');

function applySettingsToForm() {
  settingTemp.value = settings.temp;
  settingTempVal.textContent = settings.temp;
  settingTokens.value = settings.nPredict;
  settingTopK.value = settings.topK;
  settingTopP.value = settings.topP;
  settingTopPVal.textContent = settings.topP;
  settingSystemPrompt.value = settings.systemPrompt;
  settingTtsMode.value = settings.ttsMode;
  settingHistoryLength.value = settings.historyLength;
  settingStreaming.checked = settings.streamingDisplay;
}

settingTemp.addEventListener('input', () => {
  settingTempVal.textContent = settingTemp.value;
});

settingTopP.addEventListener('input', () => {
  settingTopPVal.textContent = settingTopP.value;
});

settingSave.addEventListener('click', () => {
  settings = {
    temp: parseFloat(settingTemp.value),
    nPredict: parseInt(settingTokens.value, 10) || DEFAULT_SETTINGS.nPredict,
    topK: parseInt(settingTopK.value, 10) || DEFAULT_SETTINGS.topK,
    topP: parseFloat(settingTopP.value),
    systemPrompt: settingSystemPrompt.value || DEFAULT_SETTINGS.systemPrompt,
    ttsMode: settingTtsMode.value,
    historyLength: parseInt(settingHistoryLength.value, 10) ?? DEFAULT_SETTINGS.historyLength,
    streamingDisplay: settingStreaming.checked,
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

  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('通知が許可されませんでした（設定アプリでこのアプリへの通知を許可してください）');
      return;
    }

    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Service Workerの準備がタイムアウトしました')), 10000)
      ),
    ]);

    const vapidRes = await fetch('/api/vapid-public-key');
    if (!vapidRes.ok) {
      throw new Error(`公開鍵の取得に失敗 (status: ${vapidRes.status})`);
    }
    const { publicKey } = await vapidRes.json();

    let existingSub = await reg.pushManager.getSubscription();
    if (existingSub) {
      await existingSub.unsubscribe();
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const subscribeRes = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: getUserId(), subscription: sub.toJSON() }),
    });

    if (!subscribeRes.ok) {
      throw new Error(`サーバーへの登録に失敗 (status: ${subscribeRes.status})`);
    }

    alert('通知を有効化しました');
  } catch (error) {
    console.error('通知の有効化に失敗しました', error);
    alert(`通知の有効化に失敗しました: ${error.message}`);
  }
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

    const modeLabel = r.mode === 'precise' ? '[高精度]' : '';
    const label = document.createElement('span');
    label.textContent = `${modeLabel}${new Date(r.time).toLocaleString('ja-JP')} ${r.title}（残り${r.remainingCount}/${r.totalCount}回）`;

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
    const serverList = await fetch(`/api/reminders?userId=${encodeURIComponent(getUserId())}`).then((r) => r.json());

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
  const preciseEl = document.getElementById('preciseModeToggle');

  if (!timeEl.value) {
    alert('日時を選択してください');
    return;
  }

  const epoch = new Date(timeEl.value).getTime();
  const count = parseInt(countEl.value, 10) || 1;
  const title = titleEl.value || 'VoiceAI';

  const payload = {
    userId: getUserId(),
    time: epoch,
    title,
    body: '設定した予定の時間になりました',
    count,
    precise: preciseEl.checked,
  };

  try {
    const res = await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      alert('高精度モードの本日の利用上限に達しました。通常モードで追加してください。');
      return;
    }

    const created = await res.json();
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

function updateSettingsAdState() {
  const slot2 = document.getElementById('adSlot2');
  const offline2 = document.getElementById('offlineLabel2');
  if (!slot2 || !offline2) return;

  if (!navigator.onLine) {
    slot2.style.display = 'none';
    offline2.style.display = 'block';
    return;
  }

  offline2.style.display = 'none';
  slot2.style.display = 'block';

  if (isLocalHost()) return;
  if (slot2.dataset.loaded) return;
  slot2.dataset.loaded = 'true';

  const container = document.createElement('div');
  container.id = 'container-5c341483bd75fe891511676bb07d07e5';
  slot2.appendChild(container);

  const script = document.createElement('script');
  script.async = true;
  script.setAttribute('data-cfasync', 'false');
  script.src = 'https://pl30409060.effectivecpmnetwork.com/5c341483bd75fe891511676bb07d07e5/invoke.js';
  slot2.appendChild(script);
}

document.querySelector('.tabBtn[data-page="settingsPage"]').addEventListener('click', updateSettingsAdState);
window.addEventListener('online', updateSettingsAdState);
window.addEventListener('offline', updateSettingsAdState);

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

/* ==================== 法的ページ ==================== */

let legalReturnPage = 'settingsPage';

document.querySelectorAll('.legalLinkBtn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.legal;
    const res = await fetch(`/legal/${key}.html`);
    const html = await res.text();
    document.getElementById('legalContent').innerHTML = html;
    legalReturnPage = 'settingsPage';

    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.getElementById('legalPage').classList.add('active');
  });
});

document.getElementById('calcExamplesBtn').addEventListener('click', () => {
  document.getElementById('legalContent').innerHTML = buildCalcExamplesHtml();
  legalReturnPage = 'calcPage';

  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById('legalPage').classList.add('active');
});

document.getElementById('legalBackBtn').addEventListener('click', () => {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById(legalReturnPage).classList.add('active');
});

/* ==================== 初期化 ==================== */

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    sendMessage();
  }
});

downloadBtn.addEventListener('click', loadModel);

async function restoreChatFromHistory() {
  try {
    const messages = await dbGetAll('messages');
    const recent = messages.filter((m) => m.role !== 'photo').slice(-settings.historyLength);

    recent.forEach((m) => {
      const wrap = document.createElement('div');
      wrap.className = m.role === 'user' ? 'msgWrap msgWrap-user' : 'msgWrap msgWrap-ai';
      const col = document.createElement('div');
      col.className = 'msgCol';
      const bubble = document.createElement('div');
      bubble.className = m.role === 'user' ? 'msg msg-user' : 'msg msg-ai';
      bubble.textContent = m.content;
      const meta = document.createElement('div');
      meta.className = 'msgMeta';
      const time = document.createElement('span');
      time.textContent = new Date(m.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      meta.appendChild(time);
      col.appendChild(bubble);
      col.appendChild(meta);
      wrap.appendChild(col);
      logEl.prepend(wrap);

      conversationHistory.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    });
  } catch (e) {
    console.error('会話履歴の復元に失敗しました', e);
  }
}

document.getElementById('resetEverythingBtn').addEventListener('click', async () => {
  const ok = confirm('チャット・AIモデル・キャッシュ・会話履歴・お気に入り・メモ・通知設定・計算履歴など、保存されているすべてのデータを削除します。この操作は元に戻せません。よろしいですか？');
  if (!ok) return;

  logEl.innerHTML = '';
  conversationHistory = [];
  calcLogItems = [];

  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch (e) { console.error(e); }

  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) { names.push(name); }
    for (const name of names) { await root.removeEntry(name, { recursive: true }); }
  } catch (e) { console.error(e); }

  try {
    await dbClear('messages');
    await dbClear('favorites');
    await dbClear('notes');
  } catch (e) { console.error(e); }

  const userId = localStorage.getItem(USER_ID_KEY);
  if (userId) {
    try {
      const list = await fetch(`/api/reminders?userId=${encodeURIComponent(userId)}`).then((r) => r.json());
      await Promise.all(list.map((r) => fetch(`/api/reminders/${r.id}`, { method: 'DELETE' })));
    } catch (e) { console.error(e); }

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
    } catch (e) { console.error(e); }
  }

  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(USER_ID_KEY);

  alert('すべてのデータを削除しました。ページを再読み込みします。');
  location.reload();
});

setupModelSelect();
setupReminderCountSelect();
setupCalcCommandsPanel();
applySettingsToForm();
restoreChatFromHistory();

// 以前選択したモデルがあれば自動で読み込む(キャッシュ済みならほぼ一瞬で復元される)
if (localStorage.getItem(STORAGE_KEY)) {
  loadModel();
}