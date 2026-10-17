const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");

const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const crypto = require("crypto");
const {
  requireAccountPassword,
  getAccountVerificationMethod,
  sendAccountOtp,
} = require("../middlewares/accountPasswordMiddleware");

const otpValue = (action, otp) =>
  `acct:${action}:${crypto.createHash("sha256").update(otp).digest("hex")}`;
const userController = require("../controllers/userController");

const suffix = `${Date.now()}-${process.pid}`;
const created = [];

const makeRes = () => {
  const out = { status: 200, body: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
  };
  return { res, out };
};

/** Runs middleware then (if it calls next) the controller, like the router does. */
const run = async (middleware, controller, req) => {
  const { res, out } = makeRes();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });
  if (passed) await controller(req, res);
  return { ...out, passed };
};

const makeUser = async ({ label, password = "Password123!", withDetails = false }) => {
  const user = await User.create({
    name: `Acct ${label}`,
    email: `acct-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: password ? await bcrypt.hash(password, 10) : null,
    role: withDetails ? "tradesman" : "client",
    provider: password ? "manual" : "google",
  });
  created.push(user.id);

  if (withDetails) {
    const trade = await TradesType.findOne();
    await TradesmanDetails.create({
      userId: user.id,
      tradeType: trade.name,
      tradeTypeId: trade.id,
      businessName: "Acct Co",
      shortBio: "bio",
    });
  }
  return user;
};

test.after(async () => {
  await TradesmanDetails.destroy({ where: { userId: created } });
  await User.destroy({ where: { id: created } });
  await sequelize.close();
});

const deleteReq = (user, body) => ({
  user: { id: user.id, role: user.role },
  params: { id: String(user.id) },
  body,
});

test("delete account needs the password", async () => {
  const user = await makeUser({ label: "nopass", withDetails: true });
  const mw = requireAccountPassword("DELETE", { onlyOwnAccountParam: "id" });

  const missing = await run(mw, userController.deleteUser, deleteReq(user, {}));
  assert.equal(missing.passed, false);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "PASSWORD_REQUIRED");

  const wrong = await run(mw, userController.deleteUser, deleteReq(user, { password: "nope" }));
  assert.equal(wrong.passed, false);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "INCORRECT_PASSWORD");
  assert.ok(await User.findByPk(user.id), "account must survive a wrong password");
});

test("correct password deletes the account and its tradesman profile", async () => {
  const user = await makeUser({ label: "ok", withDetails: true });
  const mw = requireAccountPassword("DELETE", { onlyOwnAccountParam: "id" });

  const result = await run(
    mw,
    userController.deleteUser,
    deleteReq(user, { password: "Password123!" }),
  );
  assert.equal(result.passed, true);
  assert.equal(result.status, 200);
  assert.equal(await User.findByPk(user.id), null);
  assert.equal(await TradesmanDetails.findOne({ where: { userId: user.id } }), null);
});

test("accounts without a password confirm with an emailed code", async () => {
  const user = await makeUser({ label: "google", password: null });
  const mw = requireAccountPassword("DELETE", { onlyOwnAccountParam: "id" });

  const missing = await run(mw, userController.deleteUser, deleteReq(user, {}));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "OTP_REQUIRED");

  const wrong = await run(mw, userController.deleteUser, deleteReq(user, { otp: "123456" }));
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "INVALID_OTP");

  // A code issued for a different action does not work.
  await user.update({
    resetPasswordToken: otpValue("CANCEL", "654321"),
    resetPasswordExpires: new Date(Date.now() + 60000),
  });
  const wrongAction = await run(mw, userController.deleteUser, deleteReq(user, { otp: "654321" }));
  assert.equal(wrongAction.status, 403);

  // Expired code.
  await user.update({
    resetPasswordToken: otpValue("DELETE", "111111"),
    resetPasswordExpires: new Date(Date.now() - 1000),
  });
  const expired = await run(mw, userController.deleteUser, deleteReq(user, { otp: "111111" }));
  assert.equal(expired.status, 403);

  // Valid code deletes the account.
  await user.update({
    resetPasswordToken: otpValue("DELETE", "222222"),
    resetPasswordExpires: new Date(Date.now() + 60000),
  });
  const ok = await run(mw, userController.deleteUser, deleteReq(user, { otp: "222222" }));
  assert.equal(ok.status, 200);
  assert.equal(await User.findByPk(user.id), null);
});

test("a code can only be used once", async () => {
  const user = await makeUser({ label: "once", password: null });
  const mw = requireAccountPassword("CANCEL");
  await user.update({
    resetPasswordToken: otpValue("CANCEL", "333333"),
    resetPasswordExpires: new Date(Date.now() + 60000),
  });
  const req = { user: { id: user.id, role: "tradesman" }, body: { otp: "333333" } };

  const first = await run(mw, async () => {}, req);
  assert.equal(first.passed, true);
  const second = await run(mw, async () => {}, req);
  assert.equal(second.passed, false);
  assert.equal(second.status, 403);
});

test("verification method and OTP endpoint follow the account type", async () => {
  const withPassword = await makeUser({ label: "method-pw" });
  const noPassword = await makeUser({ label: "method-google", password: null });

  const pw = makeRes();
  await getAccountVerificationMethod({ user: { id: withPassword.id } }, pw.res);
  assert.equal(pw.out.body.data.method, "password");

  const g = makeRes();
  await getAccountVerificationMethod({ user: { id: noPassword.id } }, g.res);
  assert.equal(g.out.body.data.method, "otp");

  const refused = makeRes();
  await sendAccountOtp({ user: { id: withPassword.id }, body: { action: "DELETE" } }, refused.res);
  assert.equal(refused.out.status, 400);
  assert.equal(refused.out.body.code, "PASSWORD_ACCOUNT");

  const badAction = makeRes();
  await sendAccountOtp({ user: { id: noPassword.id }, body: { action: "NOPE" } }, badAction.res);
  assert.equal(badAction.out.status, 400);
});

test("deleting another user's account is still refused", async () => {
  const owner = await makeUser({ label: "owner" });
  const other = await makeUser({ label: "other" });
  const mw = requireAccountPassword("DELETE", { onlyOwnAccountParam: "id" });

  const result = await run(mw, userController.deleteUser, {
    user: { id: other.id, role: "client" },
    params: { id: String(owner.id) },
    body: { password: "Password123!" },
  });
  assert.equal(result.status, 403);
  assert.ok(await User.findByPk(owner.id));
});

test("cancel subscription is blocked until the password is confirmed", async () => {
  const user = await makeUser({ label: "cancel", withDetails: true });
  const mw = requireAccountPassword("CANCEL");
  let reached = false;
  const controller = async () => {
    reached = true;
  };
  const req = (body) => ({ user: { id: user.id, role: "tradesman" }, body });

  assert.equal((await run(mw, controller, req({}))).status, 400);
  assert.equal((await run(mw, controller, req({ password: "bad" }))).status, 403);
  assert.equal(reached, false);

  const ok = await run(mw, controller, req({ password: "Password123!" }));
  assert.equal(ok.passed, true);
  assert.equal(reached, true);
});
