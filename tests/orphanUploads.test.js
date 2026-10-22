const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findOrphanFiles, deleteFiles, toBasename } = require("../services/orphanUploadService");

test("toBasename reduces every stored shape to the file name", () => {
  assert.equal(toBasename("abc.jpg"), "abc.jpg");
  assert.equal(toBasename("profile/abc.jpg"), "abc.jpg");
  assert.equal(toBasename("/uploads/profile/abc.jpg"), "abc.jpg");
  assert.equal(toBasename("https://api.example.com/uploads/license/abc.jpg?v=2"), "abc.jpg");
  assert.equal(toBasename("C:\\uploads\\abc.jpg"), "abc.jpg");
  assert.equal(toBasename(null), null);
  assert.equal(toBasename(""), null);
});

test("only unreferenced, old, non-dotfiles are orphans, and deleting removes just those", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orphan-uploads-"));
  const write = async (relative, ageMs = 2 * 60 * 60 * 1000) => {
    const full = path.join(root, relative);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, "data");
    const when = new Date(Date.now() - ageMs);
    await fs.promises.utimes(full, when, when);
    return full;
  };

  try {
    const used = await write("profile/used.jpg");
    const usedLegacy = await write("legacy-used.jpg"); // bare filename at the root
    const orphan = await write("license/orphan.jpg");
    const orphanRoot = await write("old-orphan.jfif");
    const fresh = await write("portfolio/fresh.jpg", 1000); // just uploaded, row not saved yet
    const keep = await write("profile/.gitkeep");

    const referenced = new Set(["used.jpg", "legacy-used.jpg"]);
    const result = await findOrphanFiles({ rootDir: root, referenced });

    assert.deepEqual(result.orphans.map((file) => file.path).sort(), [orphan, orphanRoot].sort());
    assert.equal(result.kept, 2);
    assert.equal(result.tooNew, 1);

    const { deleted, failed } = await deleteFiles(result.orphans);
    assert.equal(deleted, 2);
    assert.equal(failed.length, 0);

    for (const survivor of [used, usedLegacy, fresh, keep]) {
      assert.ok(fs.existsSync(survivor), `${survivor} must survive`);
    }
    assert.ok(!fs.existsSync(orphan));
    assert.ok(!fs.existsSync(orphanRoot));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("a missing uploads folder is simply empty", async () => {
  const result = await findOrphanFiles({
    rootDir: path.join(os.tmpdir(), `does-not-exist-${Date.now()}`),
    referenced: new Set(),
  });
  assert.deepEqual(result, { orphans: [], kept: 0, tooNew: 0 });
});
