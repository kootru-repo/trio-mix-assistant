"use strict";
(() => {
    const f = document.getElementById("f"), pin = document.getElementById("pin"), err = document.getElementById("err");
    f.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        let r;
        try {
            r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ pin: pin.value }) });
        }
        catch (_) {
            err.textContent = "Network error.";
            return;
        }
        if (r.ok) {
            location.href = "/";
        }
        else {
            err.textContent = r.status === 429 ? "Too many tries — wait a moment." : "Wrong PIN.";
            pin.value = "";
            pin.focus();
        }
    };
})();
