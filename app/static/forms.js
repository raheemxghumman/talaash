document.querySelectorAll("form[data-busy]").forEach((form) => {
  form.addEventListener("submit", () => {
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = form.dataset.busy;
  });
});
