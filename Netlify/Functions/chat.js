// Netlify Function (v2) — streams Claude responses to the browser as SSE.
// The Anthropic stream is forwarded straight through; the frontend parses the
// text deltas. This removes the old "wait for the whole answer" wall-clock that
// caused requests to time out for longer responses.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: { message: message } }), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

function trimMessages(messages, maxMessages) {
  maxMessages = maxMessages || 10;
  if (!Array.isArray(messages)) return [];
  const trimmed = messages.slice(-maxMessages);
  // Ensure we start with a user message (never cut mid-pair)
  const firstUser = trimmed.findIndex(function (m) { return m.role === 'user'; });
  return firstUser > 0 ? trimmed.slice(firstUser) : trimmed;
}

function trimSystem(system, maxChars) {
  maxChars = maxChars || 3000;
  if (!system || system.length <= maxChars) return system;
  return system.slice(0, maxChars) + '\n\n[System prompt truncated for length]';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') return jsonError('Method not allowed', 405);

  let body;
  try { body = await req.json(); }
  catch (e) { return jsonError('Invalid request body: ' + e.message, 400); }

  // Per-user key (stored only in the user's browser) takes priority; otherwise
  // fall back to the site-wide key configured in Netlify.
  const userKey = (typeof body.userApiKey === 'string' && body.userApiKey.trim().startsWith('sk-ant-')) ? body.userApiKey.trim() : '';
  const apiKey = userKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError('No API key available. Set one in the app (Config > API key) or add ANTHROPIC_API_KEY in Netlify > Site config > Environment variables.', 500);
  }

  // Stream only when the caller opts in (the support chat). Other callers
  // (port research, device auto-fill) want a single buffered JSON response.
  const wantStream = body.stream === true;

  const payload = {
    // Allow the app to pick a known-good model; anything else falls back to
    // Sonnet so a stale frontend can never send a dead model id.
    model: (body.model === 'claude-haiku-4-5-20251001' || body.model === 'claude-sonnet-4-6') ? body.model : 'claude-sonnet-4-6',
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 1400, 1), 2000),
    system: trimSystem(body.system || '', 3000),
    messages: trimMessages(body.messages || [], 10)
  };
  if (wantStream) payload.stream = true;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return jsonError('Upstream connection failed: ' + e.message, 502);
  }

  // API errors (4xx/5xx) arrive as a normal JSON body, not a stream — pass the
  // JSON straight back so the frontend can surface the real message.
  if (!upstream.ok || !upstream.body) {
    let txt = '';
    try { txt = await upstream.text(); } catch (e) {}
    return new Response(txt || JSON.stringify({ error: { message: 'Upstream error ' + upstream.status } }), {
      status: upstream.status || 502,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
    });
  }

  // Forward the SSE stream to the client as it arrives.
  if (wantStream) {
    return new Response(upstream.body, {
      status: 200,
      headers: Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform'
      }, CORS)
    });
  }

  // Buffered path: return the single JSON message unchanged.
  let out = '';
  try { out = await upstream.text(); } catch (e) {}
  return new Response(out || JSON.stringify({ error: { message: 'Empty response from Anthropic' } }), {
    status: upstream.status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}
