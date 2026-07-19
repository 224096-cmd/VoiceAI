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
  qwen_math15b_iq4nl:
    'https://huggingface.co/bartowski/Qwen2.5-Math-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Math-1.5B-Instruct-IQ4_NL.gguf',
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

async function sendReminderNow(env, reminder) {
  const subIds = await getIndex(env, 'sub-index');
  const subs = [];
  for (const id of subIds) {
    const raw = await env.VOICEAI_KV.get(`sub:${id}`);
    if (raw) subs.push({ id, sub: JSON.parse(raw) });
  }

  if (subs.length === 0) {
    console.log('通知購読先が登録されていません');
    return;
  }

  const vapidPrivateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);
  const remaining = reminder.remainingCount - 1;

  for (const { id: subId, sub } of subs) {
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
        await env.VOICEAI_KV.delete(`sub:${subId}`);
        await removeFromIndex(env, 'sub-index', subId);
      }
    } catch (e) {
      console.error('push failed', e);
    }
  }

  if (remaining <= 0) {
    await env.VOICEAI_KV.delete(`reminder:${reminder.id}`);
    await removeFromIndex(env, 'reminder-index', reminder.id);
  } else {
    await env.VOICEAI_KV.put(
      `reminder:${reminder.id}`,
      JSON.stringify({ ...reminder, remainingCount: remaining })
    );
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
      const sub = await request.json();
      const id = btoa(sub.endpoint).replace(/[^a-zA-Z0-9]/g, '').slice(0, 80);
      await env.VOICEAI_KV.put(`sub:${id}`, JSON.stringify(sub));
      await addToIndex(env, 'sub-index', id);
      return json({ ok: true });
    }

    if (url.pathname === '/api/reminders' && request.method === 'GET') {
      const ids = await getIndex(env, 'reminder-index');
      const reminders = [];
      for (const id of ids) {
        const raw = await env.VOICEAI_KV.get(`reminder:${id}`);
        if (raw) reminders.push(JSON.parse(raw));
      }
      reminders.sort((a, b) => a.time - b.time);
      return json(reminders);
    }

    if (url.pathname === '/api/reminders' && request.method === 'POST') {
      const body = await request.json();
      const id = crypto.randomUUID();
      const count = Math.min(5, Math.max(1, parseInt(body.count, 10) || 1));
      const reminder = {
        id,
        time: body.time,
        title: body.title || 'VoiceAI',
        body: body.body || '設定した予定の時間になりました',
        remainingCount: count,
        totalCount: count,
      };
      await env.VOICEAI_KV.put(`reminder:${id}`, JSON.stringify(reminder));
      await addToIndex(env, 'reminder-index', id);

      return json(reminder);
    }

    if (url.pathname.startsWith('/api/reminders/') && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      await env.VOICEAI_KV.delete(`reminder:${id}`);
      await removeFromIndex(env, 'reminder-index', id);
      return json({ ok: true });
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

    console.log("scheduled:", new Date(now).toISOString());

    const reminderIds = await getIndex(env, 'reminder-index');
    if (reminderIds.length === 0) return;

    for (const id of reminderIds) {
      const raw = await env.VOICEAI_KV.get(`reminder:${id}`);
      if (!raw) continue;
      
      const r = JSON.parse(raw);
      console.log({
        now: new Date(now).toISOString(),
        reminder: new Date(r.time).toISOString(),
      });
      if (r.remainingCount > 0 && r.time <= now) {
        await sendReminderNow(env, r);
      }
    }
  },
};