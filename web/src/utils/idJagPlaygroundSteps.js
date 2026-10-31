// The playground steps each mode shows. The page decides step 6 from this, and the story tests check story steps against it.
// (SAML sign-in also hides step 6, because it has no refresh token to revoke; that is per run, not per mode.)

export const MODE_STEPS = {
  mock: [1, 2, 3, 4, 5, 6],
  "pf-as": [1, 2, 3, 4, 5, 6],
  "pf-pf": [1, 2, 3, 4, 5, 6],
  byo: [1, 2, 3, 4, 5],
};
