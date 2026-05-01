const multer = require('multer');
const sharp = require('sharp');
const { resolveStorageCategory } = require('../services/storage/helpers/storagePath');

/**
 * Shared in-memory upload middleware.
 *
 * Why memory storage:
 * - validation happens before persistence
 * - image transformation happens in memory
 * - the storage provider decides the final backend (local now, S3 later)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(null, false);
    req.fileValidationError =
      'Invalid image format. Allowed formats: JPG, JPEG, PNG.';
  },
});

/**
 * Converts uploaded images to JPEG in memory and annotates files with the
 * metadata required by the storage service.
 *
 * Controllers stay storage-agnostic by consuming:
 * - `file.processedBuffer`
 * - `file.processedMimeType`
 * - `file.processedExtension`
 * - `file.storageCategory`
 */
const convertToJpg = async (req, res, next) => {
  if (req.fileValidationError) {
    return res.status(400).json({
      success: false,
      message: req.fileValidationError,
    });
  }

  try {
    if (!req.files && !req.file) {
      return next();
    }

    const files = [];

    if (req.file) {
      files.push(req.file);
    }

    if (req.files) {
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else {
        Object.values(req.files).forEach((value) => {
          if (Array.isArray(value)) {
            files.push(...value);
          }
        });
      }
    }

    for (const file of files) {
      file.processedBuffer = await sharp(file.buffer)
        .jpeg({ quality: 90 })
        .toBuffer();
      file.processedMimeType = 'image/jpeg';
      file.processedExtension = 'jpg';
      file.storageCategory = resolveStorageCategory(file.fieldname);
    }

    return next();
  } catch (error) {
    console.error('Image processing error:', error);
    return res.status(400).json({
      success: false,
      message: 'Invalid image file',
    });
  }
};

module.exports = {
  upload,
  convertToJpg,
};
