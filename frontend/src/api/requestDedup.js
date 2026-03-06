const inFlightGetRequests = new Map();

function buildParamsFingerprint(params = {}) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function buildGetRequestKey(url, params = {}) {
  const query = buildParamsFingerprint(params);
  return `${url}?${query}`;
}

export function dedupedGet(url, params, requestFactory) {
  const requestKey = buildGetRequestKey(url, params);
  const existingPromise = inFlightGetRequests.get(requestKey);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = Promise.resolve()
    .then(() => requestFactory())
    .finally(() => {
      inFlightGetRequests.delete(requestKey);
    });

  inFlightGetRequests.set(requestKey, promise);
  return promise;
}
