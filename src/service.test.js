const request = require('supertest');
const app = require('./service');
const version = require('./version.json');
const { StatusCodeError, asyncHandler } = require('./endpointHelper.js');
const { DB } = require('./database/database.js');

// Let the database finish initializing so its logging doesn't land after the tests end.
beforeAll(() => DB.initialized);

test('welcome page', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'welcome to JWT Pizza', version: version.version });
});

test('docs list the endpoints', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body.version).toBe(version.version);
  expect(res.body.endpoints.length).toBeGreaterThan(0);
  expect(res.body.config.db).toBeDefined();
});

test('unknown endpoint', async () => {
  const res = await request(app).get('/api/nope');
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown endpoint');
});

test('CORS headers', async () => {
  const res = await request(app).get('/').set('Origin', 'https://pizza.example.com');
  expect(res.headers['access-control-allow-origin']).toBe('https://pizza.example.com');
});

test('StatusCodeError carries a status code', () => {
  const err = new StatusCodeError('teapot', 418);
  expect(err.message).toBe('teapot');
  expect(err.statusCode).toBe(418);
});

test('asyncHandler passes errors to next', async () => {
  const err = new Error('boom');
  const next = jest.fn();
  await asyncHandler(async () => {
    throw err;
  })({}, {}, next);
  expect(next).toHaveBeenCalledWith(err);
});
