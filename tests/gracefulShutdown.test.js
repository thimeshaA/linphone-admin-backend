jest.mock('../config/db', () => ({
  flexisipPool: { query: jest.fn() },
  adminPool: { query: jest.fn() },
}));

const { createShutdownHandler } = require('../utils/gracefulShutdown');

const silentLog = { log: jest.fn(), error: jest.fn() };

function fakeServer({ closeError = null, hang = false } = {}) {
  return {
    close: jest.fn((cb) => {
      if (!hang) cb(closeError);
    }),
  };
}

function fakePool({ endError = null } = {}) {
  return { end: jest.fn(() => (endError ? Promise.reject(endError) : Promise.resolve())) };
}

describe('createShutdownHandler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('closes the server, ends both pools, then exits 0', async () => {
    const order = [];
    const server = { close: jest.fn((cb) => { order.push('server'); cb(); }) };
    const pools = [
      { end: jest.fn(async () => { order.push('pool1'); }) },
      { end: jest.fn(async () => { order.push('pool2'); }) },
    ];
    const exit = jest.fn();

    await createShutdownHandler({ server, pools, exit, log: silentLog })('SIGTERM');

    expect(order).toEqual(['server', 'pool1', 'pool2']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('accepts a server getter, and skips closing when startup has not reached listen()', async () => {
    const pools = [fakePool(), fakePool()];
    const exit = jest.fn();

    await createShutdownHandler({ server: () => null, pools, exit, log: silentLog })('SIGINT');

    expect(pools[0].end).toHaveBeenCalled();
    expect(pools[1].end).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('exits 1 after the hard timeout when the server never finishes closing', async () => {
    jest.useFakeTimers();
    const pools = [fakePool(), fakePool()];
    const exit = jest.fn();

    createShutdownHandler({ server: fakeServer({ hang: true }), pools, timeoutMs: 8000, exit, log: silentLog })('SIGTERM');

    jest.advanceTimersByTime(7999);
    expect(exit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(pools[0].end).not.toHaveBeenCalled();
  });

  test('exits 1 when ending a pool fails', async () => {
    const exit = jest.fn();

    await createShutdownHandler({
      server: fakeServer(),
      pools: [fakePool(), fakePool({ endError: new Error('boom') })],
      exit,
      log: silentLog,
    })('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('ignores a second signal while already shutting down', async () => {
    const server = fakeServer();
    const exit = jest.fn();
    const shutdown = createShutdownHandler({ server, pools: [fakePool()], exit, log: silentLog });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('index.js signal handlers', () => {
  test('are not registered when the app is imported (tests, not the main module)', () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };

    jest.isolateModules(() => {
      require('../index');
    });

    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
  });
});
