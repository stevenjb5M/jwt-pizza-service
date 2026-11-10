const request = require('supertest');
const app = require('./service.js');
const metrics = require('./metrics.js');

function find(all, name, attrs = {}) {
  return all.find(
    (m) =>
      m.name === name &&
      Object.entries(attrs).every(([k, v]) => (m.sum ?? m.gauge).dataPoints[0].attributes.some((a) => a.key === k && a.value.stringValue === v))
  );
}

function value(metric) {
  const point = (metric.sum ?? metric.gauge).dataPoints[0];
  return point.asInt ?? point.asDouble;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('counts requests by method and route pattern', async () => {
  await request(app).get('/');
  await request(app).get('/api/order/menu');
  await request(app).get('/nope');
  await request(app).get('/api/franchise/7?page=2');

  const all = metrics.buildMetrics();
  expect(find(all, 'http_requests', { method: 'GET', endpoint: '/api/franchise/:id' })).toBeDefined();
  expect(value(find(all, 'http_requests', { method: 'GET', endpoint: '/' }))).toBeGreaterThanOrEqual(1);
  expect(value(find(all, 'http_requests', { method: 'GET', endpoint: '/api/order/menu' }))).toBeGreaterThanOrEqual(1);
  expect(find(all, 'http_latency', { method: 'GET', endpoint: '/api/order/menu' }).unit).toBe('ms');
  expect(find(all, 'http_requests', { endpoint: 'unknown' })).toBeDefined();
});

test('tracks auth attempts and active users', async () => {
  const before = metrics.buildMetrics();
  const failuresBefore = value(find(before, 'auth_attempts', { status: 'failure' }));

  await request(app).put('/api/auth').send({ email: 'nobody@jwt.com', password: 'bad' });

  const after = metrics.buildMetrics();
  expect(value(find(after, 'auth_attempts', { status: 'failure' }))).toBe(failuresBefore + 1);
  expect(find(after, 'http_requests', { method: 'PUT', endpoint: '/api/auth' })).toBeDefined();
  expect(find(after, 'active_users')).toBeDefined();
});

test('active users expire after inactivity', () => {
  expect(metrics.getActiveUserCount(Date.now() + 10 * 60 * 1000)).toBe(0);
});

test('records pizza purchases', () => {
  const before = metrics.buildMetrics();
  const sold = value(find(before, 'pizzas_sold'));
  const failures = value(find(before, 'pizza_failures'));

  metrics.pizzaPurchase(true, 120, 0.05, 2);
  metrics.pizzaPurchase(false, 900, 0, 22);

  const after = metrics.buildMetrics();
  expect(value(find(after, 'pizzas_sold'))).toBe(sold + 2);
  expect(value(find(after, 'pizza_failures'))).toBe(failures + 1);
  expect(value(find(after, 'pizza_revenue'))).toBeGreaterThan(0);
  expect(find(after, 'cpu').gauge).toBeDefined();
  expect(find(after, 'memory').unit).toBe('%');
});

test('sends metrics to Grafana and logs failures', async () => {
  const config = require('./config.js');
  config.metrics = config.metrics ?? { source: 'test', endpointUrl: 'http://grafana.test', accountId: '1', apiKey: 'k' };
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});

  global.fetch = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'denied' }).mockRejectedValueOnce(new Error('offline'));

  await metrics.sendMetricsToGrafana(metrics.buildMetrics());
  await metrics.sendMetricsToGrafana([]);
  await metrics.sendMetricsToGrafana([]);

  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).resourceMetrics[0].scopeMetrics[0].metrics.length).toBeGreaterThan(0);
  expect(error).toHaveBeenCalledTimes(2);
});

test('sends periodically', () => {
  jest.useFakeTimers();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  const timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  clearInterval(timer);
  jest.useRealTimers();
});
