// Shared behaviour for public pages: scroll reveals, tilt cards, form helpers.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // reveal on scroll
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  document.querySelectorAll(".reveal, .steps-track").forEach((el) => io.observe(el));

  // 3D tilt on cards
  if (!reduce && matchMedia("(hover: hover)").matches) {
    document.querySelectorAll(".tilt").forEach((card) => {
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5;
        const y = (ev.clientY - r.top) / r.height - 0.5;
        card.style.transform = `rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg) translateZ(0)`;
      });
      card.addEventListener("pointerleave", () => (card.style.transform = ""));
    });
  }

  // tap-to-add hints for the report box
  document.querySelectorAll("[data-hint]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const box = document.getElementById(chip.dataset.target);
      const add = chip.dataset.hint;
      box.value = (box.value.trim() ? box.value.trim() + " " : "") + add;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  });

  // sending overlay with honest progress steps
  document.querySelectorAll("form[data-sending]").forEach((form) => {
    form.addEventListener("submit", () => {
      const overlay = document.getElementById(form.dataset.sending);
      if (!overlay) return;
      form.querySelector("button[type=submit]").disabled = true;
      overlay.classList.add("on");
      const items = overlay.querySelectorAll("li");
      items.forEach((li, i) => setTimeout(() => li.classList.add("on"), 300 + i * 1900));
    });
  });

  // animate meters
  document.querySelectorAll(".meter i[data-w]").forEach((bar) => requestAnimationFrame(() => setTimeout(() => (bar.style.width = bar.dataset.w), 120)));
})();
