const crypto = require("crypto");
const sharp = require("sharp");
const { DUMMY_EMAIL_DOMAIN } = require("../config/dummyUsers");

/**
 * Realistic-looking (but obviously fake) data for test users. Everything random goes through `rng`
 * (a function returning 0..1) so tests can make it deterministic.
 */
const FIRST_NAMES = [
  "Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn",
  "Noah", "Olivia", "Liam", "Mia", "Ethan", "Ava", "Lucas", "Zoe", "Mason", "Chloe",
];
const LAST_NAMES = [
  "Nguyen", "Smith", "Patel", "Jones", "Brown", "Wilson", "Taylor", "Evans", "Martin", "Clarke",
  "Walker", "Hughes", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Hill",
];
const BIO_OPENERS = [
  "Reliable and tidy, with years of experience on residential and small commercial jobs.",
  "Friendly local pro who turns up on time and leaves the site clean.",
  "Fully equipped for repairs, installs and emergency call-outs.",
  "Quality workmanship at a fair price, with a satisfaction guarantee.",
];

const pick = (list, rng) => list[Math.floor(rng() * list.length) % list.length];
const digits = (count, rng) => Array.from({ length: count }, () => Math.floor(rng() * 10)).join("");
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "");

const generateName = (rng = Math.random) => `${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`;

const generateEmail = (name, rng = Math.random) => {
  const [first = "user", last = "test"] = String(name).split(" ");
  return `dummy.${slug(first)}.${slug(last)}.${digits(4, rng)}@${DUMMY_EMAIL_DOMAIN}`;
};

/** An Australian-style mobile number, always 10 digits. */
const generateMobile = (rng = Math.random) => `04${digits(8, rng)}`;

/** Readable but strong: 4 groups of letters/digits, e.g. "Kx7m-Qp2r-9TnB". Crypto-random, never reused. */
const generatePassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
};

const generateTradesmanProfile = (name, tradeName, rng = Math.random) => {
  const lastName = String(name).split(" ").pop();
  return {
    businessName: `${lastName} ${tradeName} Services`,
    shortBio: `${pick(BIO_OPENERS, rng)} (Test account)`,
    licenseNumber: `TEST-${digits(6, rng)}`,
    portfolioDescription: "Sample work shown for testing purposes only.",
  };
};

/** A labelled placeholder PNG, so a test profile is never mistaken for a real one. */
const buildPlaceholderImage = async (label, color) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
    <rect width="100%" height="100%" fill="${color}"/>
    <rect x="20" y="20" width="560" height="360" fill="none" stroke="#ffffff" stroke-width="6" stroke-dasharray="18 12"/>
    <text x="50%" y="46%" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="bold"
      fill="#ffffff" text-anchor="middle">TEST</text>
    <text x="50%" y="62%" font-family="Arial, Helvetica, sans-serif" font-size="34"
      fill="#ffffff" text-anchor="middle">${label}</text>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, processedBuffer: buffer, processedExtension: "png", processedMimeType: "image/png" };
};

module.exports = {
  generateName,
  generateEmail,
  generateMobile,
  generatePassword,
  generateTradesmanProfile,
  buildPlaceholderImage,
};
