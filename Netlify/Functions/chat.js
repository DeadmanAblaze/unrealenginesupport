const https = require('https');

function makeRequest(options, postData) {
      return new Promise((resolve, reject) => {
              const req = https.request(options, (res) => {
                        let data = '';
                        res.on('data', (chunk) => { data += chunk; });
                        res.on('end', () => resolve({ status: res.statusCode, body: data }));
              });
              req.on('error', (e) => reject(e));
              req.setTimeout(25000, () => {
                        req.destroy(new Error('Request timed out after 25 seconds'));
              });
              req.write(postData);
              req.end();
      });
}

exports.handler = async function(event) {
      const headers = {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Allow-Methods': 'POST, OPTIONS'
      };

      if (event.httpMethod === 'OPTIONS') {
              return { statusCode: 200, headers, body: '' };
      }

      if (event.httpMethod !== 'POST') {
              return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
              return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY not set.' } }) };
      }

      let body;
      try {
              body = JSON.parse(event.body);
      } catch(e) {
              return { statusCode: 400, headers, body: JSON.stringify({ error: { message: 'Invalid request body: ' + e.message } }) };
      }

      const payload = {
              model: 'claude-sonnet-4-5',
              max_tokens: body.max_tokens || 1000,
              system: body.system || '',
              messages: body.messages || [],
              tools: [{ type: 'web_search_20250305', name: 'web_search' }]
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
                        'anthropic-version': '2023-06-01',
                        'anthropic-beta': 'web-search-2025-03-05'
              }
      };

      try {
              const result = await makeRequest(options, postData);
              if (!result.body || result.body.trim() === '') {
                        return { statusCode: 502, headers, body: JSON.stringify({ error: { message: 'Empty response from Anthropic. HTTP: ' + result.status } }) };
              }
              let parsed;
              try {
                        parsed = JSON.parse(result.body);
              } catch(e) {
                        return { statusCode: 502, headers, body: JSON.stringify({ error: { message: 'Bad JSON from Anthropic: ' + result.body.slice(0, 200) } }) };
              }
              return { statusCode: result.status, headers, body: JSON.stringify(parsed) };
      } catch(e) {
              return { statusCode: 502, headers, body: JSON.stringify({ error: { message: 'Request failed: ' + e.message } }) };
      }
};
