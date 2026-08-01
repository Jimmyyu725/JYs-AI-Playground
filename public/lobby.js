const keySummary = document.querySelector("#key-summary");

function markAvailable(id) {
  const status = document.querySelector(id);
  if (!status) return;
  status.className = "room-status live";
  status.innerHTML = "<i></i> Live table";
}

try {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error("Health check failed");
  const health = await response.json();
  const keys = health.apiKeys ?? { holdem: health.apiKeyConfigured };
  const ready = Object.values(keys).filter(Boolean).length;
  const total = Object.keys(keys).length;

  if (health.games?.go) markAvailable("#go-status");
  if (health.games?.wuziqi) markAvailable("#wuziqi-status");

  // A DeepSeek-only setup still runs every room, so report each provider rather than
  // the OpenAI key count alone.
  const providerKeys = health.providerKeys;
  if (providerKeys) {
    const configured = Object.entries(providerKeys)
      .filter(([, games]) => Object.values(games).some(Boolean))
      .map(([provider]) => provider);
    keySummary.textContent = configured.length
      ? `Providers ready: ${configured.join(" · ")}`
      : "No provider keys configured";
  } else {
    keySummary.textContent = `${ready} of ${total} private game keys configured`;
  }
} catch {
  keySummary.textContent = "House status unavailable";
}
