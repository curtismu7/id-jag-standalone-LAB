'use strict';
// PingFederate (13.1.3, checked against a real server) refuses a Simple Username Password validator whose Users
// table is empty: HTTP 422 "Please add at least one user to the 'Users' table", on create and on delete of the last
// user. So creating the kit's validator needs at least one user up front.

/** The message to exit with when the validator must be created but no user was given; null when it is fine. */
function missingFirstUser({ exists, wanted }) {
  if (exists || wanted.length) return null;
  return 'PingFederate will not create a user store with no users: pass --users=you@pingidentity.com (one or more, comma-separated)';
}

module.exports = { missingFirstUser };
