const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

test("responses hide the framework and set nosniff", async () => {
  for (const path of ["/", "/api/admin/dashboard/summary"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.headers.get("x-powered-by"), null, `${path} must not send X-Powered-By`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${path} must send nosniff`);
  }
});
