const https = require('https');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => reject(e));
    // 9s hard timeout — keeps us inside Netlify's wall-clock limit
    req.setTimeout(9000, () => {
      req.destroy(new Error('Claude is taking too long. Please try a shorter question.'));
    });
    req.write(postData);
    req.end();
  });
}

function trimMessages(messages, maxMessages = 10) {
  // Always keep full pairs; never cut mid-conversation
  if (!Array.isArray(messages)) return [];
  const trimmed = messages.slice(-maxMessages);
  // Ensure we start with a user message (not assistant)
  const firstUser = trimmed.findIndex(m => m.role === 'user');
  return firstUser > 0 ? trimmed.slice(firstUser) : trimmed;
}

function trimSystem(system, maxChars = 3000) {
  if (!system || system.length <= maxChars) return system;
  // Keep the beginning (role + rig) and cut the source priority boilerplate
  return system.slice(0, maxChars) + '\n\n[System prompt truncated for length]';
}

exports.handler = async function(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: { message: 'Invalid request body: ' + e.message } }) };
  }

  // Per-user key (stored only in the user's browser, sent by the app) takes
  // priority; otherwise fall back to the site-wide key configured in Netlify.
  const userKey = (typeof body.userApiKey === 'string' && body.userApiKey.trim().startsWith('sk-ant-')) ? body.userApiKey.trim() : '';
  const apiKey = userKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No API key available. Set one in the app (Config > API key) or add ANTHROPIC_API_KEY in Netlify > Site config > Environment variables.' } }) };
  }

  const payload = {
    // Use sonnet — higher TPM limit (80k vs 50k for haiku) and faster on long context
    // Allow the app to pick from known-good models (Haiku for fast
    // structured lookups, Sonnet for support chat); anything else falls
    // back to Sonnet so a stale frontend can never send a dead model id.
    model: (body.model === 'claude-haiku-4-5-20251001' || body.model === 'claude-sonnet-4-6') ? body.model : 'claude-sonnet-4-6',
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 1400, 1), 2000),
    // Trim system prompt to prevent token bloat
    system: trimSystem(body.system || '', 3000),
    // Only send last 10 messages — prevents conversation history from causing rate limits
    messages: trimMessages(body.messages || [], 10)
  };

  const postData = JSON.stringify(payload);

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  try {
    const result = await makeRequest(options, postData);

    if (!result.body || result.body.trim() === '') {
      return { statusCode: 502, headers, body: JSON.stringify({ error: { message: 'Empty response from Anthropic. HTTP status: ' + result.status } }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch(e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: { message: 'Bad JSON from Anthropic: ' + result.body.slice(0, 200) } }) };
    }

    return { statusCode: result.status, headers, body: JSON.stringify(parsed) };

  } catch(e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
