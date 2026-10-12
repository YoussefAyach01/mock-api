const form = document.getElementById('create-form');
const result = document.getElementById('result');
const btn = document.getElementById('create-btn');

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  result.innerHTML = '<p>Working…</p>';
  try {
    const name = document.getElementById('pname').value.trim();
    const cname = document.getElementById('cname').value.trim();
    const seed = Number(document.getElementById('seed').value) || 0;
    let schema;
    try {
      schema = JSON.parse(document.getElementById('schema').value);
    } catch {
      result.innerHTML = '<p class="err">Schema is not valid JSON.</p>';
      btn.disabled = false;
      return;
    }

    const projRes = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name || undefined }),
    });
    const proj = await projRes.json();
    if (!projRes.ok) {
      result.innerHTML = `<p class="err">${esc(proj.error?.message ?? 'Could not create project.')}</p>`;
      btn.disabled = false;
      return;
    }

    const colRes = await fetch(`${proj.manageUrl}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${proj.manageToken}` },
      body: JSON.stringify({ name: cname, schema, seed }),
    });
    const col = await colRes.json();
    if (!colRes.ok) {
      result.innerHTML = `<p class="err">${esc(col.error?.message ?? 'Could not create collection.')}</p>`;
      btn.disabled = false;
      return;
    }

    result.innerHTML = `
      <p class="ok">Your mock API is ready.</p>
      <div class="panel">
        <strong>Base URL</strong>
        <pre>${esc(col.url)}</pre>
        <strong>API key (shown once &mdash; save it)</strong>
        <pre>${esc(proj.apiKey)}</pre>
        <strong>Manage token (shown once &mdash; keep it to edit/delete this project)</strong>
        <pre>${esc(proj.manageToken)}</pre>
        <strong>Try it</strong>
        <pre>curl -H "x-api-key: ${esc(proj.apiKey)}" ${esc(col.url)}</pre>
      </div>`;
  } catch {
    result.innerHTML = '<p class="err">Network error. Is the server running?</p>';
  } finally {
    btn.disabled = false;
  }
});
