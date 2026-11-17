const DEFAULT_TIMEOUT_MS = 8000;

// Without SIGTERM/SIGINT handlers, node running as PID 1 in a container never
// exits on `podman stop` / `systemctl stop` - it sits out the 10s stop timeout
// and gets SIGKILLed mid-request. This drains in-flight requests, closes both
// DB pools, then exits; the hard timeout is the backstop for a request or pool
// that never finishes, so a stop can never hang past the container's grace
// period.
//
// `server` is the http.Server or a function returning it - index.js passes a
// getter, since a signal can arrive during startup before listen() has run
// (in which case there is no server to close, only the pools).
function createShutdownHandler({ server, pools, timeoutMs = DEFAULT_TIMEOUT_MS, exit = process.exit, log = console }) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.log(`${signal} received - shutting down`);

    const timer = setTimeout(() => {
      log.error(`Shutdown did not finish within ${timeoutMs}ms - forcing exit`);
      exit(1);
    }, timeoutMs);
    timer.unref();

    try {
      const activeServer = typeof server === 'function' ? server() : server;
      if (activeServer) {
        await new Promise((resolve, reject) => activeServer.close((err) => (err ? reject(err) : resolve())));
      }
      await Promise.all(pools.map((pool) => pool.end()));
      clearTimeout(timer);
      exit(0);
    } catch (err) {
      clearTimeout(timer);
      log.error(`Shutdown failed: ${err.message}`);
      exit(1);
    }
  };
}

module.exports = { createShutdownHandler, DEFAULT_TIMEOUT_MS };
