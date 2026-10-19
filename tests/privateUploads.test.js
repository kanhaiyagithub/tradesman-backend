const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const storageConfig = require("../config/storage");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const {
  isPrivateUploadPath,
  resolveLicenseFiles,
} = require("../middlewares/privateUploads");

// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const suffix = `${Date.now()}-${process.pid}`;
const root = path.resolve(storageConfig.local.rootDir);
const files = {
  license: path.join(root, "license", `test-lic-${suffix}.png`),
  legacy: path.join(root, `licenseDocument-test-${suffix}.png`),
  portfolio: path.join(root, "portfolio", `test-pub-${suffix}.png`),
  html: path.join(root, "license", `test-html-${suffix}.html`),
};

let server;
let port;
let admin;
let token;
const userIds = [];

const rawGet = (urlPath, headers = {}) =>
  new Promise((resolve, reject) => {
    // http.request keeps the path exactly as written (fetch would tidy ".." and "%" for us).
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });

const auth = () => ({ Authorization: `Bearer ${token}` });

const makeTradesman = async (label, licenseDocument) => {
  const trade = await TradesType.findOne();
  assert.ok(trade, "a trade type seed is required");
  const user = await User.create({
    name: `Lic ${label}`,
    email: `lic-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
    isVerified: false,
  });
  userIds.push(user.id);
  await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: "Lic Co",
    licenseDocument,
  });
  return user;
};

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Lic Admin",
    email: `lic-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  fs.writeFileSync(files.license, PNG);
  fs.writeFileSync(files.legacy, PNG);
  fs.writeFileSync(files.portfolio, PNG);
  fs.writeFileSync(files.html, "<script>alert(1)</script>");

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const file of Object.values(files)) fs.rmSync(file, { force: true });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

test("isPrivateUploadPath sees through case, encoding, slashes and dot tricks", () => {
  for (const blocked of [
    "/license/a.jpg",
    "/LICENSE/a.jpg",
    "/%6cicense/a.jpg",
    "/%4CICENSE/a.jpg",
    "//license/a.jpg",
    "/./license/a.jpg",
    "/portfolio/../license/a.jpg",
    "/license./a.jpg",
    "/license /a.jpg",
    "\\license\\a.jpg",
    "/licenseDocument-1764226468550-574578433.jpg",
    "/LICENSEDOCUMENT-1.jpg",
    "/license-1777616779533-fbb1f8cbbe5c.jpg",
    "/%zz-not-valid-encoding",
  ]) {
    assert.equal(isPrivateUploadPath(blocked), true, `${blocked} must be blocked`);
  }

  for (const open of [
    "/",
    "",
    "/profile/a.jpg",
    "/portfolio/license-photo.jpg", // "license" only in a later segment is fine
    "/portfolio/a.jfif",
    "/profileImage-1764226468543-871622955.jfif",
    "/portfolioPhotos-1.jfif",
    "/portfolio/../profile/a.jpg",
  ]) {
    assert.equal(isPrivateUploadPath(open), false, `${open} must stay public`);
  }
});

test("resolveLicenseFiles only offers places inside the uploads licence area", () => {
  const r = path.resolve("/srv/uploads");
  const inLicense = (name) => path.join(r, "license", name);

  assert.deepEqual(resolveLicenseFiles(r, "license/a.png"), [inLicense("a.png")]);
  // A licence-named legacy file may also sit in the uploads root.
  assert.deepEqual(resolveLicenseFiles(r, "license/licenseDocument-1.jpg"), [
    inLicense("licenseDocument-1.jpg"),
    path.join(r, "licenseDocument-1.jpg"),
  ]);
  // Traversal attempts are reduced to a file name inside the licence folder, never outside it.
  assert.deepEqual(resolveLicenseFiles(r, "license/../../etc/passwd"), [inLicense("passwd")]);
  assert.deepEqual(resolveLicenseFiles(r, "../../.env"), [inLicense(".env")]);
  for (const candidate of resolveLicenseFiles(r, "../../../windows/win.ini")) {
    assert.ok(candidate.startsWith(path.join(r, "license") + path.sep), `${candidate} escaped`);
  }
  assert.deepEqual(resolveLicenseFiles(r, ""), []);
  assert.deepEqual(resolveLicenseFiles(r, null), []);
});

test("licence files are no longer served by URL, whatever the spelling", async () => {
  const name = path.basename(files.license);
  const legacy = path.basename(files.legacy);

  for (const urlPath of [
    `/uploads/license/${name}`,
    `/uploads/LICENSE/${name}`,
    `/uploads/%6cicense/${name}`,
    `/uploads//license/${name}`,
    `/uploads/portfolio/../license/${name}`,
    `/uploads/license./${name}`,
    `/uploads/${legacy}`,
    `/uploads/${legacy.toUpperCase()}`,
  ]) {
    const response = await rawGet(urlPath);
    assert.equal(response.status, 404, `${urlPath} must not be served`);
    assert.notDeepEqual(response.body, PNG, `${urlPath} leaked the file`);
  }
});

test("portfolio and profile photos stay public", async () => {
  const response = await rawGet(`/uploads/portfolio/${path.basename(files.portfolio)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, PNG);
});

test("admins can read a licence through the authenticated route", async () => {
  const user = await makeTradesman("ok", `license/${path.basename(files.license)}`);

  assert.equal((await rawGet(`/api/admin/tradesmen/${user.id}/license`)).status, 401);

  const response = await rawGet(`/api/admin/tradesmen/${user.id}/license`, auth());
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.match(response.headers["cache-control"], /no-store/);
  assert.match(response.headers["content-security-policy"], /sandbox/);
  assert.deepEqual(response.body, PNG);
});

test("a legacy root-level licence file is readable by admins too", async () => {
  const user = await makeTradesman("legacy", `/uploads/${path.basename(files.legacy)}`);
  const response = await rawGet(`/api/admin/tradesmen/${user.id}/license`, auth());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, PNG);
});

test("missing document, unknown user and bad id return 404/400 without leaking anything", async () => {
  const none = await makeTradesman("none", null);
  assert.equal((await rawGet(`/api/admin/tradesmen/${none.id}/license`, auth())).status, 404);

  const gone = await makeTradesman("gone", "license/does-not-exist.png");
  assert.equal((await rawGet(`/api/admin/tradesmen/${gone.id}/license`, auth())).status, 404);

  assert.equal((await rawGet("/api/admin/tradesmen/999999999/license", auth())).status, 404);
  assert.equal((await rawGet("/api/admin/tradesmen/abc/license", auth())).status, 400);
});

test("a stored key that tries to escape the uploads folder cannot read other files", async () => {
  const user = await makeTradesman("escape", "license/../../package.json");
  const response = await rawGet(`/api/admin/tradesmen/${user.id}/license`, auth());
  assert.equal(response.status, 404);
  assert.ok(!response.body.toString().includes('"dependencies"'), "package.json must not be readable");
});

test("non-image files are sent as a download, never inline", async () => {
  const user = await makeTradesman("html", `license/${path.basename(files.html)}`);
  const response = await rawGet(`/api/admin/tradesmen/${user.id}/license`, auth());
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.match(response.headers["content-disposition"], /attachment/);
});
