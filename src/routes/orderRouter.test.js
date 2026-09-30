const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

let adminToken;
let dinerToken;
let menuItem;

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  let user = { password: 'testpassword', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'testpassword' };
}

function mockFactory(ok, body) {
  global.fetch = jest.fn().mockResolvedValue({ ok, json: async () => body });
}

beforeAll(async () => {
  const admin = await createAdminUser();
  adminToken = (await request(app).put('/api/auth').send(admin)).body.token;

  const diner = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  dinerToken = (await request(app).post('/api/auth').send(diner)).body.token;

  menuItem = await DB.addMenuItem({ title: randomName(), description: 'test pizza', image: 'pizza1.png', price: 0.05 });
});

afterEach(() => {
  delete global.fetch;
});

test('get menu', async () => {
  const res = await request(app).get('/api/order/menu');
  expect(res.status).toBe(200);
  expect(res.body).toContainEqual(menuItem);
});

test('admin adds a menu item', async () => {
  const item = { title: randomName(), description: 'No topping, no sauce, just carbs', image: 'pizza9.png', price: 0.0001 };
  const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(item);
  expect(res.status).toBe(200);
  expect(res.body).toContainEqual(expect.objectContaining(item));
});

test('diner cannot add a menu item', async () => {
  const res = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ title: 'nope', description: 'nope', image: 'nope.png', price: 1 });
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unable to add menu item');
});

test('create and get orders', async () => {
  mockFactory(true, { reportUrl: 'https://factory/report', jwt: 'factory.jwt.token' });
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const createRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderReq);
  expect(createRes.status).toBe(200);
  expect(createRes.body.order).toMatchObject(orderReq);
  expect(createRes.body.jwt).toBe('factory.jwt.token');
  expect(createRes.body.followLinkToEndChaos).toBe('https://factory/report');
  expect(global.fetch).toHaveBeenCalledTimes(1);

  const getRes = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
  expect(getRes.status).toBe(200);
  expect(getRes.body.page).toBe(1);
  expect(getRes.body.orders.map((o) => o.id)).toContain(createRes.body.order.id);
  const order = getRes.body.orders.find((o) => o.id === createRes.body.order.id);
  expect(order.items).toEqual([expect.objectContaining({ menuId: menuItem.id, price: menuItem.price })]);
});

test('create order when the factory fails', async () => {
  mockFactory(false, { reportUrl: 'https://factory/report' });
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderReq);
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('Failed to fulfill order at factory');
});

test('create order with unknown menu item', async () => {
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: -1, description: 'ghost', price: 1 }] };
  const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderReq);
  expect(res.status).toBe(500);
});

test('get orders requires auth', async () => {
  const res = await request(app).get('/api/order');
  expect(res.status).toBe(401);
});
