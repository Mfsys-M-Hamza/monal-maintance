'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validation failure: `fields` maps field name -> message. */
class ValidationError extends HttpError {
  constructor(message, fields = {}) {
    super(422, message);
    this.fields = fields;
  }
}

const forbidden = (msg = 'You do not have permission to perform this action.') => new HttpError(403, msg);
const notFound = (msg = 'Record not found.') => new HttpError(404, msg);

module.exports = { HttpError, ValidationError, forbidden, notFound };
