const https = require('https');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => reject(e));
    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // Step 1: env var present?
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ step: 1, status: 'FAIL', message: 'ANTHROPIC_API_KEY is not set. Add it in Netlify > Site config > Environment variables, then trigger a redeploy.' }) };
  }

  // Step 2: key format correct?
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 200, headers, body: JSON.stringify({ step: 2, status: 'FAIL', message: 'Key found but wrong format. Should start with sk-ant-. Starts with: ' + apiKey.slice(0, 8) }) };
  }

  // Step 3: can we reach Anthropic?
  const postData = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] });
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
    return { statusCode: 200, headers, body: JSON.stringify({ step: 3, status: result.status === 200 ? 'OK' : 'FAIL', httpStatus: result.status, message: result.status === 200 ? 'Everything working. API key valid, Anthropic reachable.' : 'Anthropic returned an error.', detail: result.body.slice(0, 300) }) };
  } catch(e) {
    return { statusCode: 200, headers, body: JSON.stringify({ step: 3, status: 'FAIL', message: 'Could not reach Anthropic: ' + e.message }) };
  }
};
