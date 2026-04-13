// CAC Racing API Worker
// R2 bucket: calshot-racing-results
// Secrets: ADMIN_PASSWORD, REPORT_PASSWORD

const ALLOWED_ORIGINS = [
  'https://calshot-racing.pages.dev',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, X-Report-Password',
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

function checkReportAuth(request, env) {
  return request.headers.get('X-Report-Password') === env.REPORT_PASSWORD;
}

function validKey(key) {
  return /^(series[123]|overall)_\d{4}\.html$/.test(key) ||
         /^evening_\d{4}-\d{2}-\d{2}\.html$/.test(key) ||
         /^special_\d{4}_\d{2}\.html$/.test(key) ||
         /^special_\d{4}_\d{2}\.meta\.json$/.test(key) ||
         /^SIs_\d{4}\.pdf$/.test(key) ||
         /^report_\d{4}-\d{2}-\d{2}\.(pdf|docx)$/.test(key) ||
         key === 'sailwave_links.json' ||
         key === 'report_approvals.json';
}

async function getApprovals(env) {
  try {
    const obj = await env.RACING_BUCKET.get('report_approvals.json');
    if (!obj) return {};
    return JSON.parse(await obj.text());
  } catch(e) { return {}; }
}

async function saveApprovals(env, approvals) {
  await env.RACING_BUCKET.put('report_approvals.json', JSON.stringify(approvals), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (path === '/files' && request.method === 'GET') {
      try {
        const list  = await env.RACING_BUCKET.list();
        const files = list.objects.map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size }));
        return json(files, 200, origin);
      } catch(e) { return json({ error: 'Failed to list files' }, 500, origin); }
    }

    if (path.startsWith('/file/') && request.method === 'GET') {
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
      try {
        const obj = await env.RACING_BUCKET.get(key);
        if (!obj) return json({ error: 'Not found', key }, 404, origin);
        if (key.endsWith('.pdf') || key.endsWith('.docx')) {
          const contentType = key.endsWith('.pdf')
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const bytes = await obj.arrayBuffer();
          return new Response(bytes, {
            status: 200,
            headers: { ...corsHeaders(origin), 'Content-Type': contentType, 'Content-Disposition': 'inline; filename="' + key + '"', 'Cache-Control': 'public, max-age=3600' },
          });
        }
        const content = await obj.text();
        return json({ key, content }, 200, origin);
      } catch(e) { return json({ error: 'Fetch failed' }, 500, origin); }
    }

    if (path === '/evenings' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const list = await env.RACING_BUCKET.list({ prefix: 'evening_' + year });
        const evenings = list.objects
          .map(o => { const m = o.key.match(/evening_(\d{4}-\d{2}-\d{2})\.html/); return m ? { key: o.key, date: m[1], uploaded: o.uploaded } : null; })
          .filter(Boolean)
          .sort((a, b) => b.date.localeCompare(a.date));
        return json(evenings, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    if (path === '/specials' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const list      = await env.RACING_BUCKET.list({ prefix: 'special_' + year });
        const htmlFiles = list.objects.filter(o => o.key.endsWith('.html')).sort((a, b) => b.key.localeCompare(a.key));
        const specials  = await Promise.all(htmlFiles.map(async o => {
          const metaKey = o.key.replace('.html', '.meta.json');
          let displayName = o.key;
          try { const mo = await env.RACING_BUCKET.get(metaKey); if (mo) { const meta = JSON.parse(await mo.text()); displayName = meta.displayName || displayName; } } catch(e) {}
          return { key: o.key, displayName, uploaded: o.uploaded };
        }));
        return json(specials, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

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
        if (latest.key.startsWith('special_')) {
          try { const mo = await env.RACING_BUCKET.get(latest.key.replace('.html', '.meta.json')); if (mo) { const meta = JSON.parse(await mo.text()); displayName = meta.displayName || displayName; } } catch(e) {}
        } else {
          const m = latest.key.match(/evening_(\d{4}-\d{2}-\d{2})/);
          if (m) { const p = m[1].split('-'); displayName = parseInt(p[2]) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(p[1])-1] + ' ' + p[0]; }
        }
        const obj = await env.RACING_BUCKET.get(latest.key);
        return json({ key: latest.key, displayName, content: obj ? await obj.text() : null }, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    if (path === '/upload' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      try {
        const body = await request.json();
        const { key, content, meta } = body;
        if (!key || !content) return json({ error: 'Missing key or content' }, 400, origin);
        if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
        if (key.endsWith('.pdf') || key.endsWith('.docx')) {
          const contentType = key.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const bytes = Uint8Array.from(atob(content.replace(/^data:[^;]+;base64,/, '')), c => c.charCodeAt(0));
          await env.RACING_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
        } else {
          await env.RACING_BUCKET.put(key, content, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
          if (meta && key.endsWith('.html')) {
            await env.RACING_BUCKET.put(key.replace('.html', '.meta.json'), JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
          }
        }
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Upload failed: ' + e.message }, 500, origin); }
    }

    if (path === '/upload-report' && request.method === 'POST') {
      if (!checkReportAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      try {
        const body = await request.json();
        const { key, content } = body;
        if (!key || !content) return json({ error: 'Missing key or content' }, 400, origin);
        if (!/^report_\d{4}-\d{2}-\d{2}\.(pdf|docx)$/.test(key)) return json({ error: 'Invalid key' }, 400, origin);
        const contentType = key.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const bytes = Uint8Array.from(atob(content.replace(/^data:[^;]+;base64,/, '')), c => c.charCodeAt(0));
        await env.RACING_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Upload failed: ' + e.message }, 500, origin); }
    }

    if (path === '/reports' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const [list, approvals] = await Promise.all([env.RACING_BUCKET.list({ prefix: 'report_' + year }), getApprovals(env)]);
        const reports = list.objects
          .filter(o => o.key.endsWith('.pdf') || o.key.endsWith('.docx'))
          .map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size, approved: approvals[o.key] === true }))
          .sort((a, b) => b.key.localeCompare(a.key));
        return json(reports, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    if (path === '/approved-reports' && request.method === 'GET') {
      const year = url.searchParams.get('year') || '2026';
      try {
        const [list, approvals] = await Promise.all([env.RACING_BUCKET.list({ prefix: 'report_' + year }), getApprovals(env)]);
        const reports = list.objects
          .filter(o => (o.key.endsWith('.pdf') || o.key.endsWith('.docx')) && approvals[o.key] === true)
          .map(o => { const m = o.key.match(/report_(\d{4}-\d{2}-\d{2})/); return { key: o.key, date: m ? m[1] : null }; })
          .filter(r => r.date);
        return json(reports, 200, origin);
      } catch(e) { return json({ error: 'Failed' }, 500, origin); }
    }

    if (path === '/approve-report' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      try {
        const { key } = await request.json();
        if (!key || !/^report_\d{4}-\d{2}-\d{2}\.(pdf|docx)$/.test(key)) return json({ error: 'Invalid key' }, 400, origin);
        const approvals = await getApprovals(env);
        approvals[key]  = true;
        await saveApprovals(env, approvals);
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Failed: ' + e.message }, 500, origin); }
    }

    if (path.startsWith('/file/') && request.method === 'DELETE') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      const key = decodeURIComponent(path.replace('/file/', ''));
      if (!validKey(key)) return json({ error: 'Invalid key' }, 400, origin);
      try {
        await env.RACING_BUCKET.delete(key);
        if (key.endsWith('.html')) { try { await env.RACING_BUCKET.delete(key.replace('.html', '.meta.json')); } catch(e) {} }
        if (/^report_/.test(key)) { const approvals = await getApprovals(env); delete approvals[key]; await saveApprovals(env, approvals); }
        return json({ success: true, key }, 200, origin);
      } catch(e) { return json({ error: 'Delete failed' }, 500, origin); }
    }

    if (path === '/sailwave-links' && request.method === 'GET') {
      try {
        const obj = await env.RACING_BUCKET.get('sailwave_links.json');
        if (!obj) return json({}, 200, origin);
        return json(JSON.parse(await obj.text()), 200, origin);
      } catch(e) { return json({}, 200, origin); }
    }

    if (path === '/sailwave-links' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      try {
        const body = await request.json();
        const { key, url: linkUrl } = body;
        if (!key) return json({ error: 'Missing key' }, 400, origin);
        let links = {};
        try { const obj = await env.RACING_BUCKET.get('sailwave_links.json'); if (obj) links = JSON.parse(await obj.text()); } catch(e) {}
        if (linkUrl && linkUrl.trim()) { links[key] = linkUrl.trim(); } else { delete links[key]; }
        await env.RACING_BUCKET.put('sailwave_links.json', JSON.stringify(links), { httpMetadata: { contentType: 'application/json' } });
        return json({ success: true, links }, 200, origin);
      } catch(e) { return json({ error: 'Failed: ' + e.message }, 500, origin); }
    }

    if (path === '/verify-password' && request.method === 'POST') {
      if (!checkAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      return json({ success: true }, 200, origin);
    }

    if (path === '/verify-report-password' && request.method === 'POST') {
      if (!checkReportAuth(request, env)) return json({ error: 'Unauthorised' }, 401, origin);
      return json({ success: true }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
