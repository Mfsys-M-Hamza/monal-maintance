'use strict';
const express = require('express');
const web = require('../lib/web');
const attachments = require('../services/attachments');

const router = express.Router();
router.param('id', web.numericParam);

// Authenticated, site-checked file access. Files are never served from a public path.
router.get('/:id', web.h((req, res) => {
  const { attachment, fullPath } = attachments.openForUser(req.user, Number(req.params.id));
  const disposition = req.query.download === '1' || attachment.mime_type === 'application/pdf' && req.query.inline !== '1' ? 'attachment' : 'inline';
  res.set('Content-Type', attachment.mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.set('Content-Disposition', `${disposition}; filename="${attachment.original_name.replace(/"/g, '')}"`);
  res.sendFile(fullPath);
}));

module.exports = router;
