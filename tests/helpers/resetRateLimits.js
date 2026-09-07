const { _stores } = require('../../middlewares/rateLimit');

// Test-only: fully clears every rate-limit bucket. Without this, unrelated
// tests in the same file that legitimately hit a rate-limited endpoint
// several times (e.g. logging in as the same fixture user across many
// scenarios) would trip the limiter and get 429s meant for actual abuse.
async function resetRateLimitStores() {
  await Promise.all(Object.values(_stores).map((store) => store.resetAll()));
}

module.exports = { resetRateLimitStores };
