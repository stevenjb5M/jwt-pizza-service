const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

let diner;
let dinerToken;

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

async function registerDiner() {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  const res = await request(app).post('/api/auth').send(user);
  return { user: { ...res.body.user, password: user.password }, token: res.body.token };
}

async function login(user) {
  const res = await request(app).put('/api/auth').send(user);
  return res.body.token;
}

beforeAll(async () => {
  ({ user: diner, token: dinerToken } = await registerDiner());
});

test('get authenticated user', async () => {
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: diner.id, name: diner.name, email: diner.email, roles: [{ role: 'diner' }] });
});

test('get authenticated user without a token', async () => {
  const res = await request(app).get('/api/user/me');
  expect(res.status).toBe(401);
});

test('update own user', async () => {
  const { user, token } = await registerDiner();
  const newName = randomName();
  const newEmail = newName + '@test.com';

  const res = await request(app)
    .put(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: newName, email: newEmail, password: 'b' });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: user.id, name: newName, email: newEmail });
  expect(res.body.token).toBeDefined();

  const loginRes = await request(app).put('/api/auth').send({ email: newEmail, password: 'b' });
  expect(loginRes.status).toBe(200);
});

test('cannot update another user', async () => {
  const { user: other } = await registerDiner();
  const res = await request(app)
    .put(`/api/user/${other.id}`)
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: 'hacked' });
  expect(res.status).toBe(403);
});

test('admin can update another user', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const { user: other } = await registerDiner();
  const newName = randomName();

  const res = await request(app)
    .put(`/api/user/${other.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: newName, email: other.email, password: other.password });
  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe(newName);
});

test('delete user unauthorized', async () => {
  const res = await request(app).delete(`/api/user/${diner.id}`);
  expect(res.status).toBe(401);
});

test('delete user requires admin', async () => {
  const { user: other } = await registerDiner();
  const res = await request(app).delete(`/api/user/${other.id}`).set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(403);
});

test('admin deletes user', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const { user, token } = await registerDiner();

  const res = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'user deleted' });

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(meRes.status).toBe(401);

  const listRes = await request(app).get(`/api/user?name=${user.name}`).set('Authorization', `Bearer ${adminToken}`);
  expect(listRes.body.users).toEqual([]);
});

test('list users unauthorized', async () => {
  const res = await request(app).get('/api/user');
  expect(res.status).toBe(401);
});

test('list users requires admin', async () => {
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(403);
});

test('list users', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);

  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.users.length).toBeGreaterThan(0);
  expect(typeof res.body.more).toBe('boolean');
  for (const user of res.body.users) {
    expect(user).toEqual({ id: expect.any(Number), name: expect.any(String), email: expect.any(String), roles: expect.any(Array) });
  }
});

test('list users paginates', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  await registerDiner();

  const page0 = await request(app).get('/api/user?page=0&limit=2').set('Authorization', `Bearer ${adminToken}`);
  expect(page0.status).toBe(200);
  expect(page0.body.users.length).toBe(2);
  expect(page0.body.more).toBe(true);

  const page1 = await request(app).get('/api/user?page=1&limit=2').set('Authorization', `Bearer ${adminToken}`);
  expect(page1.status).toBe(200);
  expect(page1.body.users.length).toBeGreaterThan(0);
  const page0Ids = page0.body.users.map((u) => u.id);
  for (const user of page1.body.users) {
    expect(page0Ids).not.toContain(user.id);
  }
});

test('list users filters by name', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const { user } = await registerDiner();

  const exact = await request(app).get(`/api/user?name=${user.name}`).set('Authorization', `Bearer ${adminToken}`);
  expect(exact.status).toBe(200);
  expect(exact.body.users).toEqual([{ id: user.id, name: user.name, email: user.email, roles: [{ role: 'diner' }] }]);
  expect(exact.body.more).toBe(false);

  const wildcard = await request(app).get(`/api/user?name=${user.name.substring(0, 6)}*`).set('Authorization', `Bearer ${adminToken}`);
  expect(wildcard.status).toBe(200);
  expect(wildcard.body.users.map((u) => u.id)).toContain(user.id);
});
