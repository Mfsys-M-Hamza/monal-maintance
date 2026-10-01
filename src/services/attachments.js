'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { db, nowIso } = require('../db');
const { ValidationError, notFound } = require('../lib/errors');
const access = require('../lib/access');

// Files are stored outside the public directory under random names and are only served
// through an authenticated route that checks the user's site access.
const SIGNATURES = [
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

function detect(buffer) {
  return SIGNATURES.find((s) => buffer && buffer.length > 8 && s.test(buffer)) || null;
}

/** Validate and persist an uploaded file (multer memory file). Returns attachment row. */
function save(file, { ownerType, ownerId, siteId, user, isDemo = 0 }) {
  if (!file) return null;
  const kind = detect(file.buffer);
  if (!kind) throw new ValidationError('Only PDF, JPG or PNG files are allowed.', { attachment: 'Only PDF, JPG or PNG files are allowed.' });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const stored = crypto.randomBytes(20).toString('hex') + kind.ext;
  fs.writeFileSync(path.join(config.uploadDir, stored), file.buffer, { mode: 0o600 });
  const original = path.basename(String(file.originalname || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'file';
  const { lastInsertRowid: id } = db().prepare(`INSERT INTO attachments (owner_type, owner_id, site_id, original_name, stored_name, mime_type, size_bytes, is_demo, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ownerType, ownerId, siteId, original, stored, kind.mime, file.size, isDemo, user ? user.id : null, nowIso());
  return db().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

function listFor(ownerType, ownerId) {
  return db().prepare('SELECT * FROM attachments WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY id').all(ownerType, ownerId);
}

/** Resolve an attachment for download after checking access. */
function openForUser(user, id) {
  const a = db().prepare('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) throw notFound('File not found.');
  access.assertSiteAccess(user, a.site_id);
  const full = path.join(config.uploadDir, a.stored_name);
  if (!full.startsWith(path.resolve(config.uploadDir)) || !fs.existsSync(full)) throw notFound('File not found.');
  return { attachment: a, fullPath: full };
}

function softDelete(user, id, ownerType, ownerId) {
  const a = db().prepare('SELECT * FROM attachments WHERE id = ? AND owner_type = ? AND owner_id = ? AND deleted_at IS NULL').get(id, ownerType, ownerId);
  if (!a) throw notFound('File not found.');
  access.assertSiteAccess(user, a.site_id);
  db().prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
  return a;
}

function removeFile(storedName) {
  try { fs.unlinkSync(path.join(config.uploadDir, storedName)); } catch { /* already gone */ }
}

module.exports = { save, listFor, openForUser, softDelete, removeFile, detect };
