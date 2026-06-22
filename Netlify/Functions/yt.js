// yt.js — Netlify v2 function. Fetches a YouTube video's transcript server-side
// (the browser cannot, due to CORS) so the support agent can summarise it.
// Best-effort: YouTube sometimes blocks transcript access from datacenter IPs,
// in which case this returns ok:false and the frontend offers a manual paste.

const VID_RE = /(?:v=|\/shorts\/|youtu\.be\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/;

function videoId(s){
  if(!s) return null;
  s = String(s);
  if(/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(VID_RE);
  return m ? m[1] : null;
}

// Extract the first balanced {...} JSON object that appears after a marker.
function jsonAfter(html, marker){
  const i = html.indexOf(marker);
  if(i < 0) return null;
  let j = html.indexOf('{', i);
  if(j < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for(let k = j; k < html.length; k++){
    const c = html[k];
    if(inStr){
      if(esc) esc = false;
      else if(c === '\\') esc = true;
      else if(c === '"') inStr = false;
    } else {
      if(c === '"') inStr = true;
      else if(c === '{') depth++;
      else if(c === '}'){ depth--; if(depth === 0) return html.slice(j, k + 1); }
    }
  }
  return null;
}

function decodeEntities(t){
  return String(t || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  const J = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: cors });

  if(req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if(req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);

  let body = {};
  try { body = await req.json(); } catch(e){}
  const id = videoId(body.url || body.videoId || '');
  if(!id) return J({ ok: false, error: 'Could not read a YouTube video ID from that link.' });

  let title = '', author = '', lengthSeconds = 0, tracks = [];
  try {
    const watch = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=en&bpctr=9999999999&has_verified=1', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+1' }
    });
    const html = await watch.text();
    const raw = jsonAfter(html, 'ytInitialPlayerResponse');
    if(raw){
      let pr = null;
      try { pr = JSON.parse(raw); } catch(e){}
      if(pr){
        const vd = pr.videoDetails || {};
        title = vd.title || '';
        author = vd.author || '';
        lengthSeconds = parseInt(vd.lengthSeconds || 0, 10) || 0;
        tracks = (pr.captions
          && pr.captions.playerCaptionsTracklistRenderer
          && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
        const ps = pr.playabilityStatus || {};
        if(ps.status && ps.status !== 'OK' && !tracks.length){
          return J({ ok: false, error: 'YouTube would not serve this video to the server (' + ps.status + '). Paste the transcript manually.', videoId: id, title, author, lengthSeconds });
        }
      }
    }
  } catch(e){
    return J({ ok: false, error: 'Could not reach YouTube from the server.', videoId: id });
  }

  if(!tracks.length){
    return J({ ok: false, error: 'No caption track was found (the video may have captions disabled, or YouTube blocked the server). Paste the transcript manually.', videoId: id, title, author, lengthSeconds });
  }

  // Prefer a human English track, then English auto, then anything English, then first.
  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => /^en/.test(t.languageCode || '') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => /^en/.test(t.languageCode || '')) ||
    tracks[0];

  let transcript = '';
  try {
    const base = (track.baseUrl || '').replace(/&fmt=\w+/, '');
    const cap = await fetch(base + '&fmt=json3', { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const txt = await cap.text();
    let parsed = false;
    try {
      const j = JSON.parse(txt);
      transcript = (j.events || [])
        .map(e => (e.segs || []).map(s => s.utf8 || '').join(''))
        .join(' ').replace(/\s+/g, ' ').trim();
      parsed = true;
    } catch(e){}
    if(!parsed || !transcript){
      const segs = txt.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
      transcript = segs.map(s => decodeEntities(s.replace(/<[^>]+>/g, ''))).join(' ').replace(/\s+/g, ' ').trim();
    }
  } catch(e){
    return J({ ok: false, error: 'Found captions but could not download them. Paste the transcript manually.', videoId: id, title, author, lengthSeconds });
  }

  if(!transcript){
    return J({ ok: false, error: 'The caption track came back empty. Paste the transcript manually.', videoId: id, title, author, lengthSeconds });
  }

  const MAX = 60000;
  let truncated = false;
  if(transcript.length > MAX){ transcript = transcript.slice(0, MAX); truncated = true; }

  return J({ ok: true, videoId: id, title, author, lengthSeconds, transcript, truncated });
};
