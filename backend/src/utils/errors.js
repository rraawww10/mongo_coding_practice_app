'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (message = 'Authentication required.') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (code = 'FORBIDDEN', message = 'You do not have permission to perform this action.') =>
  new AppError(403, code, message);
const notFound = (code = 'NOT_FOUND', message = 'Resource not found.') => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
