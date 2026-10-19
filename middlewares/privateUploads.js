const path = require("path");

/**
 * Licence documents are personal data and must not be reachable by URL. They live in
 * `<uploads>/license/` (current layout) and, for older uploads, as `licenseDocument-*` files
 * directly in the uploads root. Profile and portfolio photos stay public: the app shows them to clients.
 *
 * `isPrivateUploadPath` receives the path relative to the uploads mount (what express.static would
 * serve) and decides the way the file system would, not the way the raw text looks: it URL-decodes,
 * treats "\" as "/", collapses "//" and "." and resolves "..", and ignores case and the trailing
 * dots/spaces Windows strips from folder names. That stops /uploads/LICENSE/x, /uploads/%6cicense/x,
 * /uploads//license/x, /uploads/portfolio/../license/x and /uploads/license./x from slipping past.
 */
const isPrivateUploadPath = (relativePath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(String(relativePath || ""));
  } catch {
    return true; // cannot be read unambiguously, so do not serve it
  }

  const segments = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  if (!segments.length) return false;

  const first = segments[0].replace(/[. ]+$/, "").toLowerCase();
  return first === "license" || first.startsWith("licensedocument") || first.startsWith("license-");
};

/** Express middleware: mount it in front of express.static for the uploads folder. */
const blockPrivateUploads = (req, res, next) => {
  if (isPrivateUploadPath(req.path)) {
    // Same answer as a missing file, so it does not confirm that a document exists.
    return res.status(404).json({ success: false, message: "Not found" });
  }
  return next();
};

/**
 * Where a stored licence key may live on disk, best match first (empty when the key is unusable).
 * Only two places are ever allowed: `<root>/license/<file>` and, for legacy uploads, a licence-named
 * file directly in `<root>`. Anything a key tries to reach outside those (".." and the like) is
 * reduced to its file name or dropped, so it can never point at other files. The caller checks
 * which candidate actually exists.
 */
const resolveLicenseFiles = (storageRoot, key) => {
  if (!key) return [];
  const root = path.resolve(storageRoot);
  const licenseDir = path.join(root, "license");
  const name = path.basename(String(key));

  const allowed = (candidate) => {
    const dir = path.dirname(candidate);
    return dir === licenseDir || (dir === root && /^license/i.test(path.basename(candidate)));
  };

  const candidates = [path.join(licenseDir, name), path.join(root, name), path.resolve(root, String(key))];
  return [...new Set(candidates)].filter(allowed);
};

module.exports = { isPrivateUploadPath, blockPrivateUploads, resolveLicenseFiles };
