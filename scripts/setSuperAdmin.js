#!/usr/bin/env node
/**
 * Assigns the super admin role to the admin with the given email; the current super admin
 * (if any) becomes a regular admin. Use it to set the real owner in production:
 *
 *   npm run admin:set-super -- owner@example.com
 */
require('dotenv').config();

const sequelize = require('../config/db');
const Admin = require('../models/AdminModel/adminModel');
const { SuperAdminError, transferSuperAdmin } = require('../services/superAdminService');

const main = async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run admin:set-super -- <admin-email>');
    process.exitCode = 1;
    return;
  }

  try {
    const admin = await Admin.findOne({ where: { email } });
    if (!admin) {
      console.error(`No admin found with email ${email}`);
      process.exitCode = 1;
      return;
    }

    const result = await transferSuperAdmin({ targetId: admin.id });
    console.log(`${email} is now the super admin (previous super admin id: ${result.previousId ?? 'none'}).`);
  } catch (error) {
    if (error instanceof SuperAdminError && error.code === 'ALREADY_SUPER_ADMIN') {
      console.log(`${email} is already the super admin. Nothing to do.`);
      return;
    }
    console.error('Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
};

main();
