const API = '/api';

export async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || res.statusText), { code: body.code || null });
  }
  return res.status === 204 ? null : res.json();
}

export const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
export const put = (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = (path) => request(path, { method: 'DELETE' });
