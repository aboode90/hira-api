#!/usr/bin/env node
/**
 * ينقل روابط Supabase Storage القديمة إلى Cloudflare R2.
 * يستخدم نفس منطق migrate_base64_images_to_storage.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const result = spawnSync(
  process.execPath,
  [path.join(__dirname, 'migrate_base64_images_to_storage.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: path.join(__dirname, '..') }
);

process.exit(result.status ?? 1);
