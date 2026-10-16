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
  // ---------- photo picker: shrink on the phone, strip location data, preview ----------
  const pick = document.getElementById("photo-pick");
  if (pick) {
    const input = pick.querySelector("#photo");
    const img = pick.querySelector("#photo-prev");
    const err = pick.querySelector(".pp-error");
    const sizeEl = pick.querySelector("#photo-size");
    const MAX = 3 * 1024 * 1024;
    const fail = (text) => { err.textContent = text; pick.classList.add("bad"); pick.classList.remove("has", "loading"); input.value = ""; };
    const shrink = async (file) => {
      const src = window.createImageBitmap
        ? await createImageBitmap(file, { imageOrientation: "from-image" })
        : await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
      const scale = Math.min(1, 1024 / Math.max(src.width, src.height));
      const c = document.createElement("canvas");
      c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.82));
    };
    const show = (blob, note) => {
      img.src = URL.createObjectURL(blob);
      sizeEl.textContent = note;
      pick.classList.remove("loading", "bad");
      requestAnimationFrame(() => pick.classList.add("has"));
    };
    const take = async (file) => {
      err.textContent = ""; pick.classList.remove("bad");
      if (!file) return;
      if (file.type && !/^image\//.test(file.type)) return fail("That file isn't a photo.");
      if (file.size > 25 * 1024 * 1024) return fail("That photo is too large. Try another one.");
      pick.classList.add("loading");
      try {
        const blob = await shrink(file);
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "photo.jpg", { type: "image/jpeg" }));
        input.files = dt.files;
        show(blob, `${Math.max(1, Math.round(blob.size / 1024))} KB · location data removed`);
      } catch (e) {
        if (file.size <= MAX) show(file, "Ready to send");
        else fail("We couldn't read this photo. Try a different one.");
      }
    };
    input.addEventListener("change", () => take(input.files[0]));
    pick.querySelector(".pp-remove").addEventListener("click", () => {
      input.value = ""; pick.classList.remove("has"); err.textContent = "";
      setTimeout(() => (img.src = ""), 300);
    });
    ["dragenter", "dragover"].forEach((n) => pick.addEventListener(n, (e) => { e.preventDefault(); pick.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((n) => pick.addEventListener(n, () => pick.classList.remove("drag")));
    pick.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) take(f);
    });
  }

  // ---------- voice: record, Whisper writes it down, the parent checks it ----------
  document.querySelectorAll("[data-voice]").forEach((v) => {
    const box = document.getElementById(v.dataset.voice);
    const msg = v.parentElement.querySelector(".voice-msg");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { v.hidden = true; return; }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    const bars = [...v.querySelectorAll(".wave i")];
    const time = v.querySelector(".rec-time");
    let rec, chunks = [], stream, timer, t0 = 0, ctx, raf, cancelled = false;
    const state = (s) => { v.dataset.state = s; box.closest(".voice-wrap").dataset.state = s; };
    const say = (t, bad) => { msg.textContent = t || ""; msg.classList.toggle("bad", !!bad); msg.classList.toggle("on", !!t); };
    state("idle");

    async function start() {
      say("");
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { say("The microphone is blocked. You can type instead, or allow it in your browser settings.", true); return; }
      chunks = []; cancelled = false;
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = finish;
      rec.start(250);
      t0 = Date.now();
      state("rec");
      time.textContent = "0:00";
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        time.textContent = `0:${String(Math.min(s, 60)).padStart(2, "0")}`;
        if (s >= 60) stop(false);
      }, 250);
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const an = ctx.createAnalyser();
        an.fftSize = 64;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const draw = () => {
          an.getByteFrequencyData(buf);
          bars.forEach((b, i) => (b.style.transform = `scaleY(${(0.18 + (buf[i + 2] || 0) / 255 * 0.82).toFixed(2)})`));
          raf = requestAnimationFrame(draw);
        };
        draw();
      } catch (e) { v.classList.add("no-meter"); }
    }
    function stop(cancel) {
      cancelled = cancel;
      clearInterval(timer);
      cancelAnimationFrame(raf);
      try { ctx && ctx.close(); } catch (e) {}
      if (rec && rec.state !== "inactive") rec.stop();
      stream && stream.getTracks().forEach((t) => t.stop());
    }
    async function finish() {
      if (cancelled) { state("idle"); return; }
      if (Date.now() - t0 < 1200) { state("idle"); say("That was very short. Tap the mic and say a sentence or two.", true); return; }
      state("busy");
      const type = (rec.mimeType || mime || "audio/webm");
      const blob = new Blob(chunks, { type });
      const fd = new FormData();
      fd.append("audio", blob, "voice." + (type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm"));
      try {
        const r = await fetch("/api/transcribe", { method: "POST", body: fd });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.detail || "Voice isn't available right now. Please type instead.");
        box.value = (box.value.trim() ? box.value.trim() + " " : "") + out.text;
        box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
        say("Read it over and fix anything I got wrong before you send.");
      } catch (e) {
        say(e.message || "Voice isn't available right now. Please type instead.", true);
      }
      state("idle");
    }
    v.querySelector(".mic").addEventListener("click", start);
    v.querySelector(".rec-done").addEventListener("click", () => stop(false));
    v.querySelector(".rec-cancel").addEventListener("click", () => stop(true));
  });
})();

