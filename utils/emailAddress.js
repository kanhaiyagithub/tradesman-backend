/**
 * Addresses that can never receive mail: those on top-level domains reserved for testing and
 * documentation (RFC 2606 / RFC 6761). No real mailbox can exist on them, so they are never
 * used by real people. Test (dummy) accounts are created on a `.test` address by default, and
 * sending to those would only produce bounces and hurt the sender reputation of the real mail account.
 *
 * Deliberately NOT included: example.com / example.net / example.org. They are ordinary domains as far
 * as this code goes, so behaviour for any address on them is unchanged.
 *
 * A tester who wants to receive emails gives a real inbox instead (for example you+d1@gmail.com).
 */
const RESERVED_TLDS = ["test", "example", "invalid", "localhost", "local"];

const domainOf = (address) => {
  const match = String(address || "").match(/@([^@\s>]+)>?\s*$/);
  return match ? match[1].toLowerCase().replace(/\.+$/, "") : "";
};

const isSingleUndeliverable = (address) => {
  const domain = domainOf(address);
  return Boolean(domain) && RESERVED_TLDS.includes(domain.split(".").pop());
};

/** True when every recipient in `to` (a string, a comma list or an array) is on a reserved domain. */
const isUndeliverableAddress = (to) => {
  const list = (Array.isArray(to) ? to : String(to || "").split(",")).filter((item) => String(item).trim());
  return list.length > 0 && list.every(isSingleUndeliverable);
};

module.exports = { isUndeliverableAddress };
