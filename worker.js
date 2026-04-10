// CAC Racing API Worker
// R2 bucket: calshot-racing-results
// Secret: ADMIN_PASSWORD

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
  return request.headers.get('X-Admin-Password') === env.ADMIN_PASSWORD;
}

// Valid key patterns:
// series1_2026.html, series2_2026.html, series3_2026.html
// overall_2026.html
// evening_2026-04-14.html
// special_2026_01.html (with metadata sidecar: special_2026_01.meta.json)
function validKey(key) {
  return /^(series[123]|overall)_\d{4}\.html$/.test(key) ||
         /^evening_\d{4}-\d{2}-\d{2}\.html$/.test(key) ||
         /^special_\d{4}_\d{2}\.html$/.test(key) ||
         /^special_\d{4}_\d{2}\.meta\.json$/.test(key);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET /files — list all files
    if (path === '/files' && request.method === 'GET') {
      try {
        const list = await env.RACING_BUCKET.list();
        const files = list.objects.map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size }));
        return json(files, 200, origin);
      } catch(e) { return json({ error: 'Failed to list files' }, 500, origin); }
    }

    // GET /file/:key
    if (path.startsWith('/file/') && request.method === 'GET') {
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
      try {
        const obj = await env.RACING_BUCKET.get(key);
        if (!obj) return json({ error: 'Not found', key }, 404, origin);
        const content = await obj.text();
        return json({ key, content }, 200, origin);
      } catch(e) { return json({ error: 'Fetch failed' }, 500, origin); }
    }

    // GET /evenings?year=2026 — list evening files for a year
    if (path === '/evenings' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const list = await env.RACING_BUCKET.list({ prefix: 'evening_' + year });
        const evenings = list.objects
          .map(o => {
            const m = o.key.match(/evening_(\d{4}-\d{2}-\d{2})\.html/);
            return m ? { key: o.key, date: m[1], uploaded: o.uploaded } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.date.localeCompare(a.date));
        return json(evenings, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    // GET /specials?year=2026 — list special race files with metadata
    if (path === '/specials' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const list = await env.RACING_BUCKET.list({ prefix: 'special_' + year });
        const htmlFiles = list.objects
          .filter(o => o.key.endsWith('.html'))
          .sort((a, b) => b.key.localeCompare(a.key)); // newest number first

        const specials = await Promise.all(htmlFiles.map(async o => {
          const metaKey = o.key.replace('.html', '.meta.json');
          let displayName = o.key;
          try {
            const metaObj = await env.RACING_BUCKET.get(metaKey);
            if (metaObj) {
              const meta = JSON.parse(await metaObj.text());
              displayName = meta.displayName || displayName;
            }
          } catch(e) {}
          return { key: o.key, displayName, uploaded: o.uploaded };
        }));

        return json(specials, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    // GET /latest — most recently uploaded file across all types
    if (path === '/latest' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const [eveningList, specialList] = await Promise.all([
          env.RACING_BUCKET.list({ prefix: 'evening_' + year }),
          env.RACING_BUCKET.list({ prefix: 'special_' + year }),
        ]);
        const candidates = [
          ...eveningList.objects.filter(o => o.key.endsWith('.html')),
          ...specialList.objects.filter(o => o.key.endsWith('.html')),
        ].sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

        if (!candidates.length) return json({ key: null }, 200, origin);

        const latest = candidates[0];
        let displayName = latest.key;

        // Check for special meta
        if (latest.key.startsWith('special_')) {
          const metaKey = latest.key.replace('.html', '.meta.json');
          try {
            const metaObj = await env.RACING_BUCKET.get(metaKey);
            if (metaObj) {
              const meta = JSON.parse(await metaObj.text());
              displayName = meta.displayName || displayName;
            }
          } catch(e) {}
        } else {
          const m = latest.key.match(/evening_(\d{4}-\d{2}-\d{2})/);
          if (m) {
            const parts = m[1].split('-');
            displayName = parseInt(parts[2]) + ' ' +
              ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(parts[1])-1] +
              ' ' + parts[0];
          }
        }

        const obj = await env.RACING_BUCKET.get(latest.key);
        const content = obj ? await obj.text() : null;
        return json({ key: latest.key, displayName, content }, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    // POST /upload
    if (path === '/upload' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      try {
        const body = await request.json();
        const { key, content, meta } = body;
        if (!key || !content) return json({ error: 'Missing key or content' }, 400, origin);
        if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
        await env.RACING_BUCKET.put(key, content, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
        // Store metadata if provided (for special races)
        if (meta && key.endsWith('.html')) {
          const metaKey = key.replace('.html', '.meta.json');
          await env.RACING_BUCKET.put(metaKey, JSON.stringify(meta), {
            httpMetadata: { contentType: 'application/json' },
          });
        }
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Upload failed: ' + e.message }, 500, origin); }
    }

    // DELETE /file/:key
    if (path.startsWith('/file/') && request.method === 'DELETE') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
      try {
        await env.RACING_BUCKET.delete(key);
        // Also delete meta if exists
        if (key.endsWith('.html')) {
          try { await env.RACING_BUCKET.delete(key.replace('.html', '.meta.json')); } catch(e) {}
        }
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Delete failed' }, 500, origin); }
    }

    // POST /verify-password
    if (path === '/verify-password' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      return json({ success: true }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
