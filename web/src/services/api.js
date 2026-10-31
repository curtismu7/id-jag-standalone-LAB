// Tiny same-origin JSON client with an axios-like shape ({ status, data }, err.response),
// so the page reads the same for the real API and the mock.
async function request(method, url, body, { validateStatus = (s) => s >= 200 && s < 300 } = {}) {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
  const res = { status: r.status, data };
  if (!validateStatus(r.status)) throw Object.assign(new Error(`HTTP ${r.status}`), { response: res });
  return res;
}

export default {
  get: (url, opts) => request("GET", url, undefined, opts),
  post: (url, body = {}, opts) => request("POST", url, body, opts),
  put: (url, body = {}, opts) => request("PUT", url, body, opts),
  delete: (url, opts) => request("DELETE", url, undefined, opts),
};
