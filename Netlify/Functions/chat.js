const https = require('https');

function makeRequest(options, postData) {
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', function(e) { reject(e); });
    req.setTimeout(25000, function() {
      req.destroy(new Error('Request timed out'));
    });
    req.write(postData);
    req.end();
  });
}

exports.handler = async function(event) {
  var respHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: respHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: respHeaders, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  var body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: { message: 'Invalid request body: ' + e.message } }) };
  }

  var ownerEmail = 'matthew.whalen87@icloud.com';
  var apiKey = null;

  if (body.userApiKey && body.userApiKey.trim().startsWith('sk-ant-')) {
    apiKey = body.userApiKey.trim();
  } else if (body.userEmail === ownerEmail) {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  if (!apiKey) {
    return {
      statusCode: 403,
      headers: respHeaders,
      body: JSON.stringify({ error: { message: 'NO_API_KEY' } })
    };
  }

  var payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: body.max_tokens || 1000,
    system: body.system || '',
    messages: body.messages || [],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  };

  var postData = JSON.stringify(payload);

  var reqOptions = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    }
  };

  try {
    var result = await makeRequest(reqOptions, postData);
    if (!result.body || result.body.trim() === '') {
      return { statusCode: 502, headers: respHeaders, body: JSON.stringify({ error: { message: 'Empty response. HTTP: ' + result.status } }) };
    }
    var parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch(e) {
      return { statusCode: 502, headers: respHeaders, body: JSON.stringify({ error: { message: 'Bad JSON: ' + result.body.slice(0, 200) } }) };
    }
    return { statusCode: result.status, headers: respHeaders, body: JSON.stringify(parsed) };
  } catch(e) {
    return { statusCode: 502, headers: respHeaders, body: JSON.stringify({ error: { message: 'Request failed: ' + e.message } }) };
  }
};
