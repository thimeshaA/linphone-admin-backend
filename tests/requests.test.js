const request = require('supertest');

jest.mock('../utils/mailer');

const mailer = require('../utils/mailer');
const app = require('../index');

const validReseller = {
  kind: 'reseller',
  module: 'sip',
  name: 'Jane Reseller',
  email: 'jane@example.com',
  phone: '+94770000000',
  company: 'Jane Co',
  country: 'Sri Lanka',
  website: 'https://example.com',
  reason: 'We resell SIP trunks to local businesses across the region.',
  note: 'Referred by an existing partner.',
};

const validAccount = {
  kind: 'account',
  module: 'esim',
  name: 'John Enduser',
  email: 'john@example.com',
  phone: '+94770000001',
};

describe('POST /api/requests (public access-request intake)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mailer.sendMail.mockResolvedValue(undefined);
  });

  test('reseller request succeeds for the SIP module', async () => {
    const res = await request(app).post('/api/requests').send(validReseller);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: 'Request submitted successfully' });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'enigma-admin@prometeolk.com',
        subject: expect.stringContaining('reseller'),
        text: expect.stringContaining('Jane Reseller'),
      })
    );
  });

  test('reseller request succeeds for the eSIM module', async () => {
    const res = await request(app)
      .post('/api/requests')
      .send({ ...validReseller, module: 'esim' });

    expect(res.status).toBe(201);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('account request succeeds for the eSIM module', async () => {
    const res = await request(app).post('/api/requests').send(validAccount);

    expect(res.status).toBe(201);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('account request is rejected with 400 for the SIP module', async () => {
    const res = await request(app)
      .post('/api/requests')
      .send({ ...validAccount, module: 'sip' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'SIP accounts cannot be self-requested' });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('missing required field returns 400 and does not send an email', async () => {
    const { phone, ...withoutPhone } = validAccount;

    const res = await request(app).post('/api/requests').send(withoutPhone);

    expect(res.status).toBe(400);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('invalid email returns 400', async () => {
    const res = await request(app)
      .post('/api/requests')
      .send({ ...validAccount, email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('returns 502 (not a false success) when the mailer fails to send', async () => {
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));

    const res = await request(app).post('/api/requests').send(validAccount);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Failed to send request email' });
  });
});
