// CAC Racing API Worker
// Serves Sailwave HTML exports from R2 bucket: calshot-racing-results
// Deployed as: calshot-racing-api.doug-reid-21.workers.dev
// Secret: ADMIN_PASSWORD (set via: npx wrangler secret put ADMIN_PASSWORD)

const ALLOWED_ORIGINS = [
  'https://calshot-racing.pages.dev',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

function checkAuth(request, env) {
  const password = request.headers.get('X-Admin-Password');
  return password && password === env.ADMIN_PASSWORD;
}

function validKey(key) {
  return /^(series[123]|overall|evening_\d{4}-\d{2}-\d{2})\.html$/.test(key);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── PUBLIC ROUTES ─────────────────────────────────────────────

    // GET /files — list all files
    if (path === '/files' && request.method === 'GET') {
      try {
        const list = await env.RACING_BUCKET.list();
        const files = list.objects.map(obj => ({
          key: obj.key,
          uploaded: obj.uploaded,
          size: obj.size,
        }));
        return json(files, 200, origin);
      } catch (e) {
        return json({ error: 'Failed to list files' }, 500, origin);
      }
    }

    // GET /file/:key — fetch a specific file
    if (path.startsWith('/file/') && request.method === 'GET') {
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid file key' }, 400, origin);
      try {
        const obj = await env.RACING_BUCKET.get(key);
        if (!obj) return json({ error: 'File not found', key }, 404, origin);
        const html = await obj.text();
        return json({ key, html }, 200, origin);
      } catch (e) {
        return json({ error: 'Failed to fetch file', key }, 500, origin);
      }
    }

    // GET /evenings — list evening files sorted newest first
    if (path === '/evenings' && request.method === 'GET') {
      try {
        const list = await env.RACING_BUCKET.list({ prefix: 'evening_' });
        const evenings = list.objects
          .map(obj => {
            const match = obj.key.match(/evening_(\d{4}-\d{2}-\d{2})\.html/);
            return match ? { key: obj.key, date: match[1], uploaded: obj.uploaded } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.date.localeCompare(a.date));
        return json(evenings, 200, origin);
      } catch (e) {
        return json({ error: 'Failed to list evenings' }, 500, origin);
      }
    }

    // ── ADMIN ROUTES (password protected) ────────────────────────

    // POST /upload — upload a file to R2
    if (path === '/upload' && request.method === 'POST') {
      if (!checkAuth(request, env)) {
        return json({ error: 'Unauthorised' }, 401, origin);
      }
      try {
        const body = await request.json();
        const { key, html } = body;
        if (!key || !html) return json({ error: 'Missing key or html' }, 400, origin);
        if (!validKey(key)) return json({ error: 'Invalid file key' }, 400, origin);
        await env.RACING_BUCKET.put(key, html, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
        return json({ success: true, key }, 200, origin);
      } catch (e) {
        return json({ error: 'Upload failed: ' + e.message }, 500, origin);
      }
    }

    // DELETE /file/:key — delete a file from R2
    if (path.startsWith('/file/') && request.method === 'DELETE') {
      if (!checkAuth(request, env)) {
        return json({ error: 'Unauthorised' }, 401, origin);
      }
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid file key' }, 400, origin);
      try {
        await env.RACING_BUCKET.delete(key);
        return json({ success: true, key }, 200, origin);
      } catch (e) {
        return json({ error: 'Delete failed: ' + e.message }, 500, origin);
      }
    }

    // POST /verify-password — check password without doing anything
    if (path === '/verify-password' && request.method === 'POST') {
      if (!checkAuth(request, env)) {
        return json({ error: 'Unauthorised' }, 401, origin);
      }
      return json({ success: true }, 200, origin);
    }

    return json({ error: 'Not found', path }, 404, origin);
  },
};
