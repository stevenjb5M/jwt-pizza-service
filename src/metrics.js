const os = require('os');
const config = require('./config.js');

const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const REPORT_PERIOD_MS = 10 * 1000;

// Cumulative counters, keyed by a JSON string of their attributes.
const httpRequests = {}; // { method, endpoint } -> count
const httpLatencyMs = {}; // { method, endpoint } -> total ms
const authAttempts = { success: 0, failure: 0 };
const pizza = { sold: 0, failures: 0, revenue: 0, latencyMs: 0, orders: 0 };

// email -> last time the user did something authenticated
const activeUsers = new Map();

function attrKey(attributes) {
  return JSON.stringify(attributes);
}

function increment(store, attributes, amount = 1) {
  const key = attrKey(attributes);
  store[key] = (store[key] || 0) + amount;
}

// Label a request by its path with ids collapsed (e.g. /api/franchise/:id) so the
// number of series stays small. Requests that matched no route are 'unknown'.
// Express resets req.baseUrl when a route errors, so the original URL is used.
function endpointName(req) {
  if (!req.route) {
    return 'unknown';
  }
  const path = req.originalUrl.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/$/, '');
  return path || '/';
}

// Express middleware: counts every request by method and endpoint, records its
// latency, and derives auth and active-user metrics from the outcome.
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const endpoint = endpointName(req);
    const attributes = { method: req.method, endpoint };
    increment(httpRequests, attributes);
    increment(httpLatencyMs, attributes, latencyMs);

    const isAuthEndpoint = endpoint === '/api/auth';
    const succeeded = res.statusCode < 400;

    if (isAuthEndpoint && req.method === 'PUT') {
      authAttempts[succeeded ? 'success' : 'failure']++;
      if (succeeded && req.body?.email) {
        activeUsers.set(req.body.email, Date.now());
      }
    } else if (isAuthEndpoint && req.method === 'DELETE' && succeeded && req.user) {
      activeUsers.delete(req.user.email);
    } else if (req.user?.email) {
      activeUsers.set(req.user.email, Date.now());
    }
  });

  next();
}

// Called by the order router after the pizza factory responds.
function pizzaPurchase(success, latencyMs, revenue, pizzaCount) {
  pizza.orders++;
  pizza.latencyMs += latencyMs;
  if (success) {
    pizza.sold += pizzaCount;
    pizza.revenue += revenue;
  } else {
    pizza.failures++;
  }
}

function getActiveUserCount(now = Date.now()) {
  for (const [email, lastSeen] of activeUsers) {
    if (now - lastSeen > ACTIVE_USER_WINDOW_MS) {
      activeUsers.delete(email);
    }
  }
  return activeUsers.size;
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  return Number(((usedMemory / totalMemory) * 100).toFixed(2));
}

function createMetric(name, value, unit, type, attributes = {}) {
  attributes = { ...attributes, source: config.metrics?.source ?? 'jwt-pizza-service-dev' };
  const valueType = Number.isInteger(value) ? 'asInt' : 'asDouble';

  const metric = {
    name,
    unit,
    [type]: {
      dataPoints: [
        {
          [valueType]: value,
          timeUnixNano: Date.now() * 1000000,
          attributes: Object.entries(attributes).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
        },
      ],
    },
  };

  if (type === 'sum') {
    metric.sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric.sum.isMonotonic = true;
  }
  return metric;
}

function buildMetrics() {
  const metrics = [];

  for (const [key, count] of Object.entries(httpRequests)) {
    metrics.push(createMetric('http_requests', count, '1', 'sum', JSON.parse(key)));
  }
  for (const [key, ms] of Object.entries(httpLatencyMs)) {
    metrics.push(createMetric('http_latency', ms, 'ms', 'sum', JSON.parse(key)));
  }

  metrics.push(createMetric('auth_attempts', authAttempts.success, '1', 'sum', { status: 'success' }));
  metrics.push(createMetric('auth_attempts', authAttempts.failure, '1', 'sum', { status: 'failure' }));

  metrics.push(createMetric('active_users', getActiveUserCount(), '{users}', 'gauge'));
  metrics.push(createMetric('cpu', getCpuUsagePercentage(), '%', 'gauge'));
  metrics.push(createMetric('memory', getMemoryUsagePercentage(), '%', 'gauge'));

  metrics.push(createMetric('pizzas_sold', pizza.sold, '1', 'sum'));
  metrics.push(createMetric('pizza_failures', pizza.failures, '1', 'sum'));
  metrics.push(createMetric('pizza_orders', pizza.orders, '1', 'sum'));
  metrics.push(createMetric('pizza_revenue', pizza.revenue, '1', 'sum'));
  metrics.push(createMetric('pizza_latency', pizza.latencyMs, 'ms', 'sum'));

  return metrics;
}

async function sendMetricsToGrafana(metrics) {
  const { endpointUrl, accountId, apiKey } = config.metrics;
  const body = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics }] }] });
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${accountId}:${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      console.error(`Failed to push metrics to Grafana: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Error pushing metrics:', error.message);
  }
}

function sendMetricsPeriodically(period = REPORT_PERIOD_MS) {
  const timer = setInterval(() => {
    try {
      sendMetricsToGrafana(buildMetrics());
    } catch (error) {
      console.error('Error building metrics:', error.message);
    }
  }, period);
  timer.unref();
  return timer;
}

if (config.metrics?.endpointUrl && process.env.NODE_ENV !== 'test') {
  sendMetricsPeriodically();
}

module.exports = { requestTracker, pizzaPurchase, buildMetrics, getActiveUserCount, sendMetricsToGrafana, sendMetricsPeriodically };
