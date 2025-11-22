const SERVER_ENDPOINT = "http://localhost:5000/notes";
const WIDGET_ID = "note-taker-widget";
const STYLE_ID = "note-widget-style";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("widget.css");
  document.head.appendChild(link);
}

function removeWidget() {
  const existing = document.getElementById(WIDGET_ID);
  if (existing) {
    existing.remove();
  }
}

function positionWidget(widget, rect) {
  const offsetTop = rect.bottom + window.scrollY + 8;
  const offsetLeft = rect.left + window.scrollX;
  widget.style.top = `${offsetTop}px`;

  const maxLeft = document.documentElement.clientWidth - widget.offsetWidth - 16;
  widget.style.left = `${Math.min(Math.max(8, offsetLeft), Math.max(8, maxLeft))}px`;
}

async function sendNote(text) {
  const payload = {
    text,
    source_url: window.location.href,
    metadata: {
      page_title: document.title,
      captured_at: new Date().toISOString(),
    },
  };

  const response = await fetch(SERVER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    mode: "cors",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to save note");
  }

  return response.json();
}

function createWidget(selectedText, rect) {
  removeWidget();
  injectStyles();

  const container = document.createElement("div");
  container.id = WIDGET_ID;
  container.className = "note-widget";
  container.innerHTML = `
    <label class="note-widget__label">Save selection</label>
    <textarea class="note-widget__textarea" rows="3"></textarea>
    <div class="note-widget__actions">
      <button class="note-widget__button note-widget__button--save">Save</button>
      <button class="note-widget__button note-widget__button--cancel" type="button">Cancel</button>
    </div>
    <p class="note-widget__status" aria-live="polite"></p>
  `;

  const textarea = container.querySelector(".note-widget__textarea");
  const status = container.querySelector(".note-widget__status");
  textarea.value = selectedText;

  container.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });

  container.querySelector(".note-widget__button--cancel").addEventListener("click", () => {
    removeWidget();
  });

  container.querySelector(".note-widget__button--save").addEventListener("click", async () => {
    const noteText = textarea.value.trim();
    if (!noteText) {
      status.textContent = "Enter some text to save.";
      return;
    }

    status.textContent = "Saving...";
    try {
      await sendNote(noteText);
      status.textContent = "Saved!";
      textarea.blur();
      setTimeout(removeWidget, 1200);
    } catch (error) {
      status.textContent = error.message || "Unable to save note.";
    }
  });

  document.body.appendChild(container);

  requestAnimationFrame(() => {
    positionWidget(container, rect);
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
  });
}

function getSelectionRect(selection) {
  if (!selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    removeWidget();
    return;
  }

  const rect = getSelectionRect(selection);
  if (!rect) {
    removeWidget();
    return;
  }

  createWidget(selectedText, rect);
}

document.addEventListener("mouseup", () => {
  setTimeout(handleSelection, 0);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    removeWidget();
  }
});

document.addEventListener("mousedown", (event) => {
  const widget = document.getElementById(WIDGET_ID);
  if (widget && !widget.contains(event.target)) {
    removeWidget();
  }
});

window.addEventListener("scroll", () => {
  removeWidget();
});
