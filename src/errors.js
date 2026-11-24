'use strict';

// The two errors a caller can fix, so the engine answers them as 4xx instead of 500.
// Every route module throws these; server.js turns `status` into the HTTP status.
// Trap: any other thrown Error is a 500 (or a 503 when its code is unreachable), so a check on
// input must throw one of these, not a plain Error.

// Errors the person can fix are 4xx, not 500: a mistyped app id is not the engine breaking.
const bad_request = (message) => Object.assign(new Error(message), { status: 400 });
const not_found = (message) => Object.assign(new Error(message), { status: 404 });

module.exports = { bad_request, not_found };
