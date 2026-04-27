/** FastAPI may return `detail` as a string or a list of validation errors. */
export function formatApiDetail(data) {
  const d = data && data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d.map((e) => (e && (e.msg || e.message)) || JSON.stringify(e)).join(" ");
  }
  return "Request failed";
}
