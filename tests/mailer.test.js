const nodemailer = require('nodemailer');

jest.mock('nodemailer');

describe('utils/mailer', () => {
  const fakeSendMail = jest.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    process.env.SMTP_FROM = 'system@admin-control.test';
    nodemailer.createTransport.mockReturnValue({ sendMail: fakeSendMail });
  });

  beforeEach(() => {
    fakeSendMail.mockClear();
  });

  test('forwards replyTo to the transporter while keeping from fixed to the configured system address', async () => {
    const { sendMail } = require('../utils/mailer');

    await sendMail({
      to: 'enigma-admin@prometeolk.com',
      subject: 'New reseller access request (SIP)',
      text: 'body',
      html: '<p>body</p>',
      replyTo: 'requester@example.com',
    });

    expect(fakeSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'system@admin-control.test',
        to: 'enigma-admin@prometeolk.com',
        replyTo: 'requester@example.com',
      })
    );
  });

  test('from never becomes the replyTo address, even when a different requester submits', async () => {
    const { sendMail } = require('../utils/mailer');

    await sendMail({
      to: 'enigma-admin@prometeolk.com',
      subject: 'New account request (eSIM)',
      text: 'body',
      replyTo: 'someone-else@example.com',
    });

    const call = fakeSendMail.mock.calls[0][0];
    expect(call.from).toBe('system@admin-control.test');
    expect(call.from).not.toBe('someone-else@example.com');
    expect(call.replyTo).toBe('someone-else@example.com');
  });

  test('omitting replyTo sends no Reply-To override (mail clients fall back to From)', async () => {
    const { sendMail } = require('../utils/mailer');

    await sendMail({ to: 'someone@example.com', subject: 'Hi', text: 'body' });

    const call = fakeSendMail.mock.calls[0][0];
    expect(call.replyTo).toBeUndefined();
    expect(call.from).toBe('system@admin-control.test');
  });
});
