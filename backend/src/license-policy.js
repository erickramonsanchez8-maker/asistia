const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Presentation-only license state. Server-side write guards remain authoritative.
 * A license never becomes operational again merely because offline grace remains.
 */
export function getLicensePresentation(state, now = Date.now()) {
  const license = state && state.license;
  const expiresAt = license ? Date.parse(license.expiresAt) : NaN;
  const daysRemaining = Number.isFinite(expiresAt)
    ? Math.ceil((expiresAt - (now instanceof Date ? now.getTime() : now)) / DAY_MS)
    : null;
  return Object.freeze({
    daysRemaining,
    showExpiryWarning: Boolean(
      state &&
      state.status === 'active' &&
      daysRemaining !== null &&
      daysRemaining >= 0 &&
      daysRemaining <= 10
    ),
    historyReadOnly: !state || state.status !== 'active'
  });
}
