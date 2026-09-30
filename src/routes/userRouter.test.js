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

test('delete user is not implemented', async () => {
  const res = await request(app).delete(`/api/user/${diner.id}`).set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('not implemented');
});

test('list users is not implemented', async () => {
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'not implemented', users: [], more: false });
});
