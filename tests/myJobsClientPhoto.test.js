// GET /api/hire/my returns the client's photo as a link. The model call is
// stubbed, so no database is needed.
const assert = require("node:assert/strict");
const test = require("node:test");

const Hire = require("../models/hireModel");
const hireController = require("../controllers/hireController");
const storageService = require("../services/storage/storageService");

const fetchJobs = async (t, rows) => {
  let query;
  t.mock.method(Hire, "findAll", async (options) => {
    query = options;
    return rows.map((row) => ({ toJSON: () => structuredClone(row) }));
  });

  let body;
  const res = {
    status() {
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };

  await hireController.getMyJobs(
    { user: { id: 1, role: "tradesman" }, query: {} },
    res
  );

  return { body, query };
};

test("the job list asks for the client's photo and returns it as a link", async (t) => {
  const { body, query } = await fetchJobs(t, [
    { id: 5, client: { id: 2, name: "Client", profileImage: "photo.jpg" } },
  ]);

  assert.equal(body.success, true);
  assert.ok(query.include[0].attributes.includes("profileImage"));
  assert.equal(
    body.data[0].client.profileImage,
    storageService.toPublicUrl("photo.jpg", { category: "profile" })
  );
  assert.match(body.data[0].client.profileImage, /photo\.jpg$/);
});

test("a client without a photo, or a deleted client, does not break the list", async (t) => {
  const { body } = await fetchJobs(t, [
    { id: 6, client: { id: 3, name: "No photo", profileImage: null } },
    { id: 7, client: null },
  ]);

  assert.equal(body.success, true);
  assert.equal(body.data[0].client.profileImage, null);
  assert.equal(body.data[1].client, null);
});
