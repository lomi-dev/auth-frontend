const params = new URLSearchParams(window.location.search);
const statuses = params.getAll("status");
const resultStatus = statuses.length === 1 ? statuses[0] : null;
const title = document.querySelector<HTMLHeadingElement>("#result-title");
const copy = document.querySelector<HTMLParagraphElement>("#result-copy");
const symbol = document.querySelector<HTMLElement>("#result-symbol");
const note = document.querySelector<HTMLElement>("#result-note");
const action = document.querySelector<HTMLAnchorElement>("#result-action");
const panel = document.querySelector<HTMLElement>("#result-panel");

if (title && copy && symbol && note && action && panel) {
  if (resultStatus === "approved") {
    title.textContent = "Device approved";
    copy.textContent = "Return to Lomi desktop to finish signing in. The app will confirm when your session is saved.";
    symbol.textContent = "✓";
    note.className = "notice notice-success result-note";
    note.textContent = "Lomi desktop securely completes sign-in after it receives your approval.";
    action.href = "/account";
    action.textContent = "Go to your account";
  } else if (resultStatus === "denied") {
    title.textContent = "Request denied";
    copy.textContent = "Lomi desktop was not connected to your account. If you still want to sign in, start a new request in the app.";
    symbol.textContent = "×";
    note.className = "notice notice-info result-note";
    note.textContent = "No desktop session was approved by this action.";
    action.href = "/device";
    action.textContent = "Back to device sign-in";
  } else if (resultStatus === "expired") {
    title.textContent = "Code no longer active";
    copy.textContent = "This device request may have expired or already been handled. Start a new sign-in in Lomi desktop.";
    symbol.textContent = "↻";
    note.className = "notice notice-warning result-note";
    note.textContent = "For your security, an old code cannot be reused.";
    action.href = "/device";
    action.textContent = "Back to device sign-in";
  } else {
    title.textContent = "Request status unavailable";
    copy.textContent = "Check Lomi desktop for the current sign-in status. It confirms when a session is saved.";
    symbol.textContent = "i";
    note.className = "notice notice-info result-note";
    note.textContent = "This page does not receive or store your Lomi session token.";
    action.href = "/login";
    action.textContent = "Go to your account";
  }

  if (resultStatus !== "approved") panel.classList.add("result-panel-neutral");
}

export {};
