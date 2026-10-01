'use strict';
const express = require('express');
const web = require('../lib/web');
const time = require('../lib/time');
const records = require('../services/records');

const router = express.Router();

router.get('/', web.h((req, res) => {
  const q = req.query;
  const f = {
    site: q.site || 'all',
    type: records.TYPES[q.type] ? q.type : '',
    q: String(q.q || '').slice(0, 100),
    from: time.isValidDate(q.from) ? q.from : '',
    to: time.isValidDate(q.to) ? q.to : '',
    mine: q.mine === '1',
  };
  const result = records.search(req.user, { ...f, page: q.page });
  res.render('records/index', { title: 'Records', f, result, types: records.TYPES });
}));

module.exports = router;
