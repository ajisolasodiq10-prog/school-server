// Responses that may carry a one-time activation or reset link must never be cached by the
// browser or a proxy.
export const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
};
