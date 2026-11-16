const request = require('supertest');

jest.mock('../config/db', () => ({
  flexisipPool: { query: jest.fn() },
  adminPool: { query: jest.fn() },
}));

const { flexisipPool, adminPool } = require('../config/db');
const app = require('../index');

describe('GET /health', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('reports ok when both DB pools are reachable', async () => {
    flexisipPool.query.mockResolvedValue([[{ 1: 1 }]]);
    adminPool.query.mockResolvedValue([[{ 1: 1 }]]);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('reports 503 and identifies which DB is unreachable when one pool fails', async () => {
    flexisipPool.query.mockRejectedValue(new Error('connect ETIMEDOUT'));
    adminPool.query.mockResolvedValue([[{ 1: 1 }]]);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', flexisipDb: 'unreachable', adminDb: 'ok' });
  });

  test('reports 503 when both DB pools are unreachable', async () => {
    flexisipPool.query.mockRejectedValue(new Error('connect ETIMEDOUT'));
    adminPool.query.mockRejectedValue(new Error('HANDSHAKE_SSL_ERROR'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', flexisipDb: 'unreachable', adminDb: 'unreachable' });
  });

  test('reports 503 when a pool hangs rather than erroring (slow/unresponsive DB)', async () => {
    flexisipPool.query.mockImplementation(() => new Promise(() => {})); // never resolves
    adminPool.query.mockResolvedValue([[{ 1: 1 }]]);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', flexisipDb: 'unreachable', adminDb: 'ok' });
  }, 10000);
});
