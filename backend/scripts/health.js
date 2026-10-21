'use strict';

/** Calls GET /api/health on the running API. Exit code 0 = healthy. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const url = process.env.HEALTH_URL || `http://localhost:${process.env.PORT || 4000}/api/health`;

fetch(url)
  .then(async (res) => {
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    process.exit(res.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`API not reachable at ${url}: ${err.message}`);
    process.exit(1);
  });
