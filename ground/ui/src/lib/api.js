const BASE = '/api';

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.error?.message || `HTTP ${res.status}`);
    err.code = json.error?.code || 'UNKNOWN';
    err.status = res.status;
    throw err;
  }
  return json;
}

export const health = {
  get: () => request('GET', '/health'),
};

export const contactWindows = {
  list: (params = '') => request('GET', `/contact-windows${params ? '?' + params : ''}`),
  getById: (id) => request('GET', `/contact-windows/${id}`),
  create: (data) => request('POST', '/contact-windows', data),
  updateStatus: (id, status) => request('PATCH', `/contact-windows/${id}`, { status }),
};

export const commandPlans = {
  list: (params = '') => request('GET', `/command-plans${params ? '?' + params : ''}`),
  getById: (id) => request('GET', `/command-plans/${id}`),
  create: (data) => request('POST', '/command-plans', data),
  sign: (id, sigData) => request('PATCH', `/command-plans/${id}`, sigData),
  upload: (id, data) => request('POST', `/command-plans/${id}/upload`, data || {}),
};

export const commands = {
  list: (params = '') => request('GET', `/commands${params ? '?' + params : ''}`),
};

export const telemetry = {
  query: (params = '') => request('GET', `/telemetry${params ? '?' + params : ''}`),
  latest: () => request('GET', '/telemetry/latest'),
};

export const events = {
  query: (params = '') => request('GET', `/events${params ? '?' + params : ''}`),
  verify: () => request('GET', '/events/verify'),
};

export const twin = {
  forecasts: (params = '') => request('GET', `/twin/forecasts${params ? '?' + params : ''}`),
  alerts: () => request('GET', '/twin/alerts'),
};

export default { health, contactWindows, commandPlans, commands, telemetry, events, twin };