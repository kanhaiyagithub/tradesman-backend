const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../../../config/storage');
const {
  resolveStorageCategory,
  getCategoryFolder,
} = require('../helpers/storagePath');

const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

/**
 * Ensures a directory exists before writing files to it.
 *
 * @param {string} dirPath - Absolute directory path.
 */
const ensureDirectory = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

/**
 * Builds a safe filename for a stored object.
 *
 * @param {string} category - Normalized storage category.
 * @param {string} extension - File extension without dot.
 * @returns {string} Filename safe for local disk.
 */
const buildFileName = (category, extension) => {
  const safeExtension = String(extension || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';

  return `${category}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${safeExtension}`;
};

/**
 * Extracts a file extension from a processed upload.
 *
 * @param {{ processedExtension?: string, processedMimeType?: string, originalname?: string }} params
 * @returns {string} Best-effort extension without dot.
 */
const getExtension = ({ processedExtension, processedMimeType, originalname }) => {
  if (processedExtension) {
    return String(processedExtension).replace(/^\./, '');
  }

  if (processedMimeType && MIME_TO_EXTENSION[processedMimeType]) {
    return MIME_TO_EXTENSION[processedMimeType];
  }

  const originalExtension = path.extname(originalname || '').replace(/^\./, '');
  return originalExtension || 'bin';
};

/**
 * Converts legacy and normalized storage values into a provider-relative key.
 *
 * Supported legacy formats:
 * - plain filename, e.g. "abc.jpg"
 * - "/uploads/profile/abc.jpg"
 * - "uploads/profile/abc.jpg"
 * - "profile/abc.jpg"
 * - absolute URL ending in "/uploads/profile/abc.jpg"
 *
 * @param {string|null|undefined} value - Stored DB value.
 * @param {{ category?: string }} [options] - Category hint for legacy filenames.
 * @returns {string|null} Provider-relative key like "profile/abc.jpg".
 */
const normalizeStorageKey = (value, options = {}) => {
  if (!value) {
    return null;
  }

  let normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return null;
  }

  const uploadsSegment = '/uploads/';
  const uploadsIndex = normalizedValue.indexOf(uploadsSegment);
  if (uploadsIndex !== -1) {
    normalizedValue = normalizedValue.slice(uploadsIndex + uploadsSegment.length);
  }

  normalizedValue = normalizedValue.replace(/^https?:\/\/[^/]+\//i, '');
  normalizedValue = normalizedValue.replace(/^uploads\//i, '');
  normalizedValue = normalizedValue.replace(/^\//, '');

  if (normalizedValue.startsWith('profile/') || normalizedValue.startsWith('portfolio/') || normalizedValue.startsWith('license/')) {
    return normalizedValue;
  }

  const resolvedCategory = options.category
    ? resolveStorageCategory(options.category)
    : null;

  return resolvedCategory ? `${resolvedCategory}/${path.basename(normalizedValue)}` : normalizedValue;
};

/**
 * Saves a processed file buffer to local storage.
 *
 * @param {{ file: object, category: string }} params
 * @returns {Promise<string>} Normalized storage key.
 */
const saveBuffer = async ({ file, category }) => {
  const normalizedCategory = resolveStorageCategory(category || file?.storageCategory || file?.fieldname);
  const folderName = getCategoryFolder(normalizedCategory);
  const extension = getExtension(file || {});
  const fileName = buildFileName(normalizedCategory, extension);
  const storageKey = `${folderName}/${fileName}`;
  const absolutePath = path.join(storageConfig.local.rootDir, storageKey);

  await ensureDirectory(path.dirname(absolutePath));

  const buffer = file?.processedBuffer || file?.buffer;
  if (!buffer) {
    throw new Error('File buffer is required for storage');
  }

  await fs.promises.writeFile(absolutePath, buffer);
  return storageKey;
};

/**
 * Deletes an object from local storage when it exists.
 *
 * @param {string|null|undefined} storageKey - Stored key or legacy value.
 * @param {{ category?: string }} [options] - Category hint for legacy values.
 */
const deleteObject = async (storageKey, options = {}) => {
  const normalizedKey = normalizeStorageKey(storageKey, options);
  if (!normalizedKey) {
    return;
  }

  const absolutePath = path.join(storageConfig.local.rootDir, normalizedKey);

  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
};

/**
 * Converts a stored value into a public URL path that the frontend can load.
 *
 * @param {string|null|undefined} storageKey - Stored key or legacy value.
 * @param {{ category?: string }} [options] - Category hint for legacy filenames.
 * @returns {string|null} Public URL.
 */
const getPublicUrl = (storageKey, options = {}) => {
  const normalizedKey = normalizeStorageKey(storageKey, options);
  if (!normalizedKey) {
    return null;
  }

  return `${storageConfig.local.publicBasePath}/${normalizedKey}`.replace(/\/+/g, '/');
};

module.exports = {
  saveBuffer,
  deleteObject,
  getPublicUrl,
  normalizeStorageKey,
};
