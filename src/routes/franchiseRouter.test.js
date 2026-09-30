const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

let adminToken;
let franchisee;
let franchiseeToken;
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
  return { user: res.body.user, token: res.body.token };
}

async function createFranchise(admins = [{ email: franchisee.email }]) {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins });
  return res;
}

beforeAll(async () => {
  const admin = await createAdminUser();
  const loginRes = await request(app).put('/api/auth').send(admin);
  adminToken = loginRes.body.token;

  ({ user: franchisee, token: franchiseeToken } = await registerDiner());
  ({ token: dinerToken } = await registerDiner());
});

test('admin creates a franchise', async () => {
  const res = await createFranchise();
  expect(res.status).toBe(200);
  expect(res.body.id).toBeDefined();
  expect(res.body.admins).toEqual([{ email: franchisee.email, id: franchisee.id, name: franchisee.name }]);
});

test('create franchise with unknown admin', async () => {
  const res = await createFranchise([{ email: randomName() + '@nobody.com' }]);
  expect(res.status).toBe(404);
});

test('diner cannot create a franchise', async () => {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: randomName(), admins: [] });
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unable to create a franchise');
});

test('list franchises', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(res.status).toBe(200);
  expect(res.body.more).toBe(false);
  expect(res.body.franchises).toEqual([{ id: franchise.id, name: franchise.name, stores: [] }]);
});

test('admin lists franchises with details', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).get(`/api/franchise?name=${franchise.name}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.franchises[0].admins[0].email).toBe(franchisee.email);
});

test('list franchises defaults to 10 per page', async () => {
  await createFranchise();
  await createFranchise();

  const res = await request(app).get('/api/franchise');
  expect(res.status).toBe(200);
  expect(res.body.franchises.length).toBeLessThanOrEqual(10);
});

test('franchisee lists own franchises', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${franchiseeToken}`);
  expect(res.status).toBe(200);
  expect(res.body.map((f) => f.id)).toContain(franchise.id);
});

test('user with no franchises', async () => {
  const { user, token } = await registerDiner();
  const res = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test("cannot list another user's franchises", async () => {
  const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('franchisee creates and deletes a store', async () => {
  const franchise = (await createFranchise()).body;

  const createRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${franchiseeToken}`)
    .send({ name: 'SLC' });
  expect(createRes.status).toBe(200);
  expect(createRes.body).toMatchObject({ franchiseId: franchise.id, name: 'SLC' });

  const deleteRes = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${createRes.body.id}`)
    .set('Authorization', `Bearer ${franchiseeToken}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('store deleted');
});

test('diner cannot create a store', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: 'SLC' });
  expect(res.status).toBe(403);
});

test('diner cannot delete a store', async () => {
  const franchise = (await createFranchise()).body;
  const store = (
    await request(app).post(`/api/franchise/${franchise.id}/store`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'SLC' })
  ).body;

  const res = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${store.id}`)
    .set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(403);
});

test('delete a franchise', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('franchise deleted');

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises).toEqual([]);
});

test('delete a franchise requires auth', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).delete(`/api/franchise/${franchise.id}`);
  expect(res.status).toBe(401);

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises.length).toBe(1);
});

test('non-admin cannot delete a franchise', async () => {
  const franchise = (await createFranchise()).body;

  const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${franchiseeToken}`);
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unable to delete a franchise');

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises.length).toBe(1);
});
