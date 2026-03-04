export function apiData(response, fallback = null) {
  return response?.data?.data ?? fallback;
}

export function apiMessage(error, fallback = "Something went wrong.") {
  return (
    error?.response?.data?.detail ||
    error?.response?.data?.errors?.detail ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
}
