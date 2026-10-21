const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Test (dummy) users live in their own world. Test users only ever see and interact with other test
 * users, real users only with real ones, so a tester can never message, hire, match with or even see
 * a real person (and vice versa). A "world" is:
 *   false = real users,  true = test (dummy) users,  null = admin (sees both).
 * Anonymous callers belong to the real world.
 */

/** Reads the bearer token on public routes (where verifyToken is not used). Never throws. */
const decodeOptionalToken = (req) => {
  const header = req?.headers?.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    return decoded && decoded.type !== "refresh" ? decoded : null;
  } catch {
    return null;
  }
};

/** The world of the person making this request (looked up once per request). */
const getRequesterWorld = async (req) => {
  if (req._dummyWorld !== undefined) return req._dummyWorld;

  const decoded = req.user || decodeOptionalToken(req);
  let world = false;

  if (decoded?.role === "admin") {
    // Admin tokens carry an Admin id, which is NOT a User id: never look it up as a user.
    world = null;
  } else if (decoded?.id) {
    const user = await User.findByPk(decoded.id, { attributes: ["isDummy"] });
    world = user ? Boolean(user.isDummy) : false;
  }

  req._dummyWorld = world;
  return world;
};

/** Sequelize `where` fragment for the Users table: only users in this world ({} for admins). */
const worldWhere = (world) => (world === null ? {} : { isDummy: Boolean(world) });

/** True when both users exist and live in the same world. Use before any user-to-user action. */
const inSameWorld = async (userIdA, userIdB) => {
  const ids = [...new Set([Number(userIdA), Number(userIdB)])];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return false;

  const users = await User.findAll({ where: { id: ids }, attributes: ["id", "isDummy"] });
  if (users.length !== ids.length) return false;
  return new Set(users.map((user) => Boolean(user.isDummy))).size === 1;
};

module.exports = { decodeOptionalToken, getRequesterWorld, worldWhere, inSameWorld };
