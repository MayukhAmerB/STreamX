export function apiData(response, fallback = null) {
  return response?.data?.data ?? fallback;
}

export function apiMessage(error, fallback = "Something went wrong.") {
  const fieldErrors = error?.response?.data?.errors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const firstKey = Object.keys(fieldErrors)[0];
    const firstVal = fieldErrors[firstKey];
    if (Array.isArray(firstVal) && firstVal.length) {
      return firstVal[0];
    }
    if (typeof firstVal === "string" && firstVal.trim()) {
      return firstVal;
    }
  }

  return (
    error?.response?.data?.detail ||
    error?.response?.data?.errors?.detail ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
}
