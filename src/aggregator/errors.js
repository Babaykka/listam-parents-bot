'use strict';

class AggregatorError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

class AccessPolicyError extends AggregatorError {
  constructor(message, status = 'not_permitted') {
    super(message);
    this.status = status;
    this.retriable = false;
  }
}

class AccessBoundaryError extends AggregatorError {
  constructor(message) {
    super(message);
    this.retriable = false;
  }
}

class HttpStatusError extends AggregatorError {
  constructor(message, status, url, retriable = false, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.url = url;
    this.retriable = retriable;
    this.retryAfterMs = retryAfterMs;
  }
}

class SecurityChallengeError extends AggregatorError {
  constructor(message, url) {
    super(message);
    this.url = url;
    this.status = 'blocked';
    this.retriable = false;
  }
}

class ValidationError extends AggregatorError {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
    this.retriable = false;
  }
}

module.exports = {
  AccessBoundaryError,
  AccessPolicyError,
  AggregatorError,
  HttpStatusError,
  SecurityChallengeError,
  ValidationError,
};
