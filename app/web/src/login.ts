(() => {
  const f = document.getElementById("f") as HTMLFormElement,
    pin = document.getElementById("pin") as HTMLInputElement,
    err = document.getElementById("err") as HTMLElement;
  f.onsubmit = async (e: SubmitEvent) => {
    e.preventDefault(); err.textContent = "";
    let r: Response;
    try {
      r = await fetch("/api/login", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({pin: pin.value})});
    } catch (_) { err.textContent = "Network error."; return; }
    if (r.ok) { location.href = "/"; }
    else { err.textContent = r.status === 429 ? "Too many tries — wait a moment." : "Wrong PIN."; pin.value = ""; pin.focus(); }
  };
})();
