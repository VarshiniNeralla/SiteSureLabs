document.addEventListener("DOMContentLoaded", () => {
  const goDashboard = () => {
    window.location.href = "/dashboard/image-analysis/";
  };
  document.querySelectorAll(".landing-cta").forEach((btn) => {
    btn.addEventListener("click", goDashboard);
  });
});
