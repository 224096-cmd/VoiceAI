import { buildPushHTTPRequest } from '@pushforge/builder';

const MODELS = {
  sarashina1b_q4:
    'https://huggingface.co/mmnga/sarashina2.2-1b-instruct-v0.1-gguf/resolve/main/sarashina2.2-1b-instruct-v0.1-Q4_K_M.gguf',
  tinyswallow15b:
    'https://huggingface.co/SakanaAI/TinySwallow-1.5B-Instruct-GGUF/resolve/main/tinyswallow-1.5b-instruct-q5_k_m.gguf',
  qwen_coder05b:
    'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
  sarashina1b_iq2xxs:
    'https://huggingface.co/mmnga/sarashina2.2-1b-instruct-v0.1-gguf/resolve/main/sarashina2.2-1b-instruct-v0.1-IQ2_XXS.gguf',
  lfm25_jp:
    'https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-GGUF/resolve/main/LFM2.5-1.2B-JP-Q4_K_M.gguf',
  qwen25_15b_q3km:
    'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q3_K_M.gguf',
  gemma3_1b_iq1m:
    'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-UD-IQ1_M.gguf',
  gemma3_1b_q4km:
    'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
  gemma3_1b_bf16:
    'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-BF16.gguf',
  qwen_math15b_q4km:
    'https://huggingface.co/bartowski/Qwen2.5-Math-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Math-1.5B-Instruct-Q4_K_M.gguf',
};

const DEFAULT_MODEL = 'sarashina1b_q4';

async function handleModelProxy(request) {
  const url = new URL(request.url);
  const modelId = url.searchParams.get('model');
  const upstreamUrl = MODELS[modelId] || MODELS[DEFAULT_MODEL];

  const requestHeaders = { 'Accept-Encoding': 'identity' };
  if (request.headers.has('range')) {
    requestHeaders['Range'] = request.headers.get('range');
  }

  const upstream = await fetch(upstreamUrl, { headers: requestHeaders });

  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');

  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('Content-Length', contentLength);

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(upstream.body, { status: upstream.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getIndex(env, key) {
  const raw = await env.VOICEAI_KV.get(key);
  return raw ? JSON.parse(raw) : [];
}

async function addToIndex(env, key, id) {
  const index = await getIndex(env, key);
  if (!index.includes(id)) {
    index.push(id);
    await env.VOICEAI_KV.put(key, JSON.stringify(index));
  }
}

async function removeFromIndex(env, key, id) {
  const index = await getIndex(env, key);
  const next = index.filter((x) => x !== id);
  await env.VOICEAI_KV.put(key, JSON.stringify(next));
}

// ---- ユーザー(端末)ごとの購読情報 ----

async function getUserSubs(env, userId) {
  if (!userId) return [];
  const raw = await env.VOICEAI_KV.get(`user:${userId}:subs`);
  return raw ? JSON.parse(raw) : [];
}

async function addUserSub(env, userId, subscription) {
  const subs = await getUserSubs(env, userId);
  const filtered = subs.filter((s) => s.endpoint !== subscription.endpoint);
  filtered.push(subscription);
  await env.VOICEAI_KV.put(`user:${userId}:subs`, JSON.stringify(filtered));
}

async function removeUserSub(env, userId, endpoint) {
  const subs = await getUserSubs(env, userId);
  const next = subs.filter((s) => s.endpoint !== endpoint);
  await env.VOICEAI_KV.put(`user:${userId}:subs`, JSON.stringify(next));
}

// reminder.userId に紐づく購読先だけへ送信する
export async function sendReminderNow(env, reminder) {
  const subs = await getUserSubs(env, reminder.userId);

  if (subs.length === 0) {
    console.log('この端末の通知購読先が登録されていません', reminder.userId);
  } else {
    const vapidPrivateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);
    const remaining = reminder.remainingCount - 1;

    for (const sub of subs) {
      try {
        const { endpoint, headers, body } = await buildPushHTTPRequest({
          privateJWK: vapidPrivateJWK,
          subscription: sub,
          message: {
            payload: {
              title: reminder.title,
              body: `${reminder.body}（${reminder.totalCount - remaining}/${reminder.totalCount}回目）`,
            },
            adminContact: env.VAPID_SUBJECT,
            options: { ttl: 3600, urgency: 'high' },
          },
        });

        const res = await fetch(endpoint, { method: 'POST', headers, body });
        if (res.status === 404 || res.status === 410) {
          await removeUserSub(env, reminder.userId, sub.endpoint);
        }
      } catch (e) {
        console.error('push failed', e);
      }
    }
  }

  const remaining = reminder.remainingCount - 1;
  const updated = { ...reminder, remainingCount: remaining };

  if (remaining <= 0) {
    await env.VOICEAI_KV.delete(`reminder:${reminder.id}`);
    await removeFromIndex(env, 'reminder-index', reminder.id);
  } else {
    await env.VOICEAI_KV.put(`reminder:${reminder.id}`, JSON.stringify(updated));
  }

  return updated;
}

// 高精度モード専用：Durable Object。1件の予定ごとに1つ生成され、正確な時刻にalarmを発火させる
export class ReminderAlarm {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/cancel') {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete('reminder');
      return new Response('cancelled');
    }

    const { reminder } = await request.json();
    await this.state.storage.put('reminder', reminder);
    await this.state.storage.setAlarm(reminder.time);
    return new Response('ok');
  }

  async alarm() {
    const reminder = await this.state.storage.get('reminder');
    if (!reminder) return;

    const updated = await sendReminderNow(this.env, reminder);

    if (updated && updated.remainingCount > 0) {
      await this.state.storage.put('reminder', updated);
      await this.state.storage.setAlarm(Date.now() + 60000);
    } else {
      await this.state.storage.delete('reminder');
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/model-proxy.gguf') {
      return handleModelProxy(request);
    }

    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      const { userId, subscription } = await request.json();
      if (!userId || !subscription) {
        return json({ error: 'userIdまたはsubscriptionがありません' }, 400);
      }
      await addUserSub(env, userId, subscription);
      return json({ ok: true });
    }

    if (url.pathname === '/api/reminders' && request.method === 'GET') {
      const userId = url.searchParams.get('userId');
      const ids = await getIndex(env, 'reminder-index');
      const reminders = [];
      for (const id of ids) {
        const raw = await env.VOICEAI_KV.get(`reminder:${id}`);
        if (raw) {
          const r = JSON.parse(raw);
          if (!userId || r.userId === userId) reminders.push(r);
        }
      }
      reminders.sort((a, b) => a.time - b.time);
      return json(reminders);
    }

    if (url.pathname === '/api/reminders' && request.method === 'POST') {
      const body = await request.json();

      if (!body.userId) {
        return json({ error: 'userIdがありません' }, 400);
      }

      const id = crypto.randomUUID();
      const count = Math.min(5, Math.max(1, parseInt(body.count, 10) || 1));
      const mode = body.precise ? 'precise' : 'cron';

      const reminder = {
        id,
        userId: body.userId,
        time: body.time,
        title: body.title || 'VoiceAI',
        body: body.body || '設定した予定の時間になりました',
        remainingCount: count,
        totalCount: count,
        mode,
      };

      if (mode === 'precise') {
        const dailyKey = `precise-usage-${new Date().toISOString().slice(0, 10)}`;
        const used = parseInt((await env.VOICEAI_KV.get(dailyKey)) || '0', 10);
        const DAILY_SAFE_LIMIT = 500;

        if (used >= DAILY_SAFE_LIMIT) {
          return json({ error: 'precise_quota_exceeded' }, 429);
        }

        const doId = env.REMINDER_ALARM.idFromName(id);
        const stub = env.REMINDER_ALARM.get(doId);
        await stub.fetch('https://do/schedule', {
          method: 'POST',
          body: JSON.stringify({ reminder }),
        });

        await env.VOICEAI_KV.put(dailyKey, String(used + 1));
      }

      await env.VOICEAI_KV.put(`reminder:${id}`, JSON.stringify(reminder));
      await addToIndex(env, 'reminder-index', id);

      return json(reminder);
    }

    if (url.pathname.startsWith('/api/reminders/') && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();

      const raw = await env.VOICEAI_KV.get(`reminder:${id}`);
      if (raw) {
        const reminder = JSON.parse(raw);
        if (reminder.mode === 'precise') {
          const doId = env.REMINDER_ALARM.idFromName(id);
          const stub = env.REMINDER_ALARM.get(doId);
          await stub.fetch('https://do/cancel');
        }
      }

      await env.VOICEAI_KV.delete(`reminder:${id}`);
      await removeFromIndex(env, 'reminder-index', id);
      return json({ ok: true });
    }

    if (url.pathname.startsWith('/hf-proxy/')) {
      const targetPath = url.pathname.slice('/hf-proxy/'.length);
      const upstreamUrl = `https://huggingface.co/${targetPath}${url.search}`;

      const upstream = await fetch(upstreamUrl, { headers: { 'Accept-Encoding': 'identity' } });

      const headers = new Headers();
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Headers', '*');
      const ct = upstream.headers.get('content-type');
      if (ct) headers.set('Content-Type', ct);
      const cl = upstream.headers.get('content-length');
      if (cl) headers.set('Content-Length', cl);

      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (url.pathname === '/api/search' && request.method === 'POST') {
      const monthKey = `search-usage-${new Date().toISOString().slice(0, 7)}`;
      const raw = await env.VOICEAI_KV.get(monthKey);
      const used = raw ? parseInt(raw, 10) : 0;
      const SAFE_LIMIT = 900;

      if (used >= SAFE_LIMIT) {
        return json({ error: 'quota_exceeded' }, 429);
      }

      const { query } = await request.json();

      const fcRes = await fetch('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, limit: 5 }),
      });

      if (!fcRes.ok) {
        return json({ error: 'search_failed' }, 502);
      }

      const data = await fcRes.json();
      await env.VOICEAI_KV.put(monthKey, String(used + 1));

      return json({ results: data.data || [] });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();

    const reminderIds = await getIndex(env, 'reminder-index');
    if (reminderIds.length === 0) return;

    for (const id of reminderIds) {
      const raw = await env.VOICEAI_KV.get(`reminder:${id}`);
      if (!raw) continue;
      const r = JSON.parse(raw);

      if (r.mode === 'precise') continue;

      if (r.remainingCount > 0 && r.time <= now) {
        await sendReminderNow(env, r);
      }
    }
  },
};