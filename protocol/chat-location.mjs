// An unusable optional fix must never prevent delivery of the user's message.
export function chatLocation(request) {
  const value = request.kind === 'chat' && request.location;
  if (!value) return;
  const { latitude, longitude, captured_at, accuracy } = value;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || !Number.isSafeInteger(captured_at) || captured_at <= 0) return;
  return { latitude, longitude, captured_at, ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}) };
}
